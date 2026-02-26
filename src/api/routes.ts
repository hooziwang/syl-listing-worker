import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { enqueueGenerateJob } from "../queue/jobs.js";
import { randomId } from "../utils/id.js";
import type { ApiContext } from "./types.js";

const bearerSchema = z.string().regex(/^Bearer\s+.+$/i);
const generateSchema = z.object({
  input_markdown: z.string().min(1, "input_markdown 不能为空"),
  candidate_count: z.number().int().positive().max(20).optional()
});
const publishSchema = z.object({
  tenant_id: z.string().min(1),
  rules_version: z.string().min(1),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  archive_base64: z.string().min(1),
  signature_base64: z.string().optional(),
  signature_algo: z.string().default("ed25519")
});

function requireAdmin(ctx: ApiContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const tokenHeader = request.headers["x-admin-token"];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    if (!token || token !== ctx.env.adminToken) {
      return reply.unauthorized("invalid_admin_token");
    }
  };
}

function requireAuth(ctx: ApiContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bearerSchema.safeParse(request.headers.authorization || "");
    if (!parsed.success) {
      return reply.unauthorized("missing_bearer_token");
    }

    const token = parsed.data.replace(/^Bearer\s+/i, "").trim();
    try {
      request.auth = ctx.authService.verifyBearerToken(token);
    } catch {
      return reply.unauthorized("invalid_bearer_token");
    }
  };
}

function requestBaseURL(request: FastifyRequest): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : typeof forwardedProto === "string" && forwardedProto.length > 0
      ? forwardedProto
      : request.protocol || "http";

  const forwardedHost = request.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : typeof forwardedHost === "string" && forwardedHost.length > 0
      ? forwardedHost
      : request.headers.host || "127.0.0.1:8080";

  return `${proto}://${host}`;
}

export async function registerRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  app.get("/healthz", async (_request, reply) => {
    const report = await ctx.llmHealthService.check();
    if (!report.ok) {
      reply.code(503);
    }
    return report;
  });

  app.post("/v1/auth/exchange", async (request, reply) => {
    const authHeader = request.headers.authorization;
    const parsedBearer = bearerSchema.safeParse(Array.isArray(authHeader) ? authHeader[0] : authHeader || "");
    if (!parsedBearer.success) {
      return reply.badRequest("missing_bearer_authorization");
    }

    const sylKey = parsedBearer.data.replace(/^Bearer\s+/i, "").trim();
    if (!sylKey) {
      return reply.badRequest("missing_bearer_authorization");
    }

    try {
      const exchanged = ctx.authService.exchangeBySylKey(sylKey);
      return exchanged;
    } catch {
      return reply.unauthorized("invalid_syl_key");
    }
  });

  app.register(async (adminApp) => {
    adminApp.addHook("preHandler", requireAdmin(ctx));

    adminApp.post("/v1/admin/tenant-rules/publish", async (request, reply) => {
      const body = publishSchema.parse(request.body);
      try {
        await ctx.rulesService.publish({
          tenant_id: body.tenant_id,
          rules_version: body.rules_version,
          manifest_sha256: body.manifest_sha256,
          archive_base64: body.archive_base64,
          signature_base64: body.signature_base64,
          signature_algo: body.signature_algo
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "publish_failed";
        return reply.badRequest(msg);
      }
      return {
        ok: true,
        tenant_id: body.tenant_id,
        rules_version: body.rules_version
      };
    });

    adminApp.post("/v1/admin/tenant-rules/rollback", async (request, reply) => {
      const body = z.object({ tenant_id: z.string().min(1), rules_version: z.string().min(1) }).parse(request.body);
      try {
        await ctx.rulesService.rollback(body.tenant_id, body.rules_version);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "rollback_failed";
        return reply.badRequest(msg);
      }
      return { ok: true, tenant_id: body.tenant_id, rules_version: body.rules_version };
    });
  });

  app.register(async (securedApp) => {
    securedApp.addHook("preHandler", requireAuth(ctx));

    securedApp.get("/v1/rules/resolve", async (request) => {
      const query = z.object({ current: z.string().optional() }).parse(request.query);
      const tenantId = request.auth!.tenant_id;
      const resolved = await ctx.rulesService.resolve(tenantId, query.current);
      resolved.download_url = `${requestBaseURL(request)}/v1/rules/download/${encodeURIComponent(tenantId)}/${encodeURIComponent(resolved.rules_version)}`;
      return resolved;
    });

    securedApp.post("/v1/rules/refresh", async (request) => {
      const tenantId = request.auth!.tenant_id;
      const resolved = await ctx.rulesService.resolve(tenantId, undefined);
      resolved.download_url = `${requestBaseURL(request)}/v1/rules/download/${encodeURIComponent(tenantId)}/${encodeURIComponent(resolved.rules_version)}`;
      return resolved;
    });

    securedApp.get("/v1/rules/download/:tenantId/:rulesVersion", async (request, reply) => {
      const params = z.object({ tenantId: z.string().min(1), rulesVersion: z.string().min(1) }).parse(request.params);
      const tenantId = request.auth!.tenant_id;
      if (tenantId !== params.tenantId) {
        return reply.forbidden("tenant_mismatch");
      }
      try {
        const archive = await ctx.rulesService.readArchive(params.tenantId, params.rulesVersion);
        reply.header("Content-Type", "application/gzip");
        reply.header("Cache-Control", "no-store");
        return reply.send(archive);
      } catch {
        return reply.notFound("rules_archive_not_found");
      }
    });

    securedApp.post("/v1/generate", async (request) => {
      const parsed = generateSchema.parse(request.body);
      const tenantId = request.auth!.tenant_id;
      const jobId = `job_${randomId(18)}`;
      const candidateCount = parsed.candidate_count ?? 1;

      await ctx.jobStore.createQueued(jobId, tenantId);
      await enqueueGenerateJob(ctx.queue, {
        job_id: jobId,
        tenant_id: tenantId,
        input_markdown: parsed.input_markdown,
        candidate_count: candidateCount
      });

      return {
        job_id: jobId,
        status: "queued"
      };
    });

    securedApp.get("/v1/jobs/:jobId", async (request, reply) => {
      const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const tenantId = request.auth!.tenant_id;

      const record = await ctx.jobStore.get(params.jobId);
      if (!record || record.tenant_id !== tenantId) {
        return reply.notFound("job_not_found");
      }

      return {
        job_id: record.id,
        status: record.status,
        error: record.error_message || undefined,
        updated_at: record.updated_at
      };
    });

    securedApp.get("/v1/jobs/:jobId/result", async (request, reply) => {
      const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const tenantId = request.auth!.tenant_id;

      const record = await ctx.jobStore.get(params.jobId);
      if (!record || record.tenant_id !== tenantId) {
        return reply.notFound("job_not_found");
      }

      if (record.status !== "succeeded") {
        return reply.code(409).send({
          error: "job_not_ready",
          status: record.status,
          message: "任务未完成，暂不可读取 result"
        });
      }

      const result = await ctx.jobStore.consumeResult(params.jobId);
      if (!result) {
        return reply.notFound("result_consumed_or_missing");
      }

      return result;
    });
  });
}
