import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
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
  signature_base64: z.string().min(1),
  signature_algo: z.string().min(1)
});

function withTenant<T extends object>(tenantId: string, payload: T): T & { tenant_id: string } {
  return {
    ...(payload as object),
    tenant_id: tenantId
  } as T & { tenant_id: string };
}

function keyFingerprint(raw: string): string {
  const v = raw.trim();
  if (!v) {
    return "";
  }
  if (v.length <= 8) {
    return `${v[0]}***${v[v.length - 1]}`;
  }
  return `${v.slice(0, 4)}***${v.slice(-4)}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function requireAdmin(ctx: ApiContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const tokenHeader = request.headers["x-admin-token"];
    const tokenFromHeader = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const tokenFromBearer = (() => {
      const parsed = bearerSchema.safeParse(request.headers.authorization || "");
      if (!parsed.success) {
        return "";
      }
      return parsed.data.replace(/^Bearer\s+/i, "").trim();
    })();
    const token = (tokenFromHeader || "").trim() || tokenFromBearer;
    if (!token || token !== ctx.env.adminToken) {
      return reply.code(401).send(withTenant("admin", { error: "invalid_admin_token" }));
    }
  };
}

function requireAuth(ctx: ApiContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bearerSchema.safeParse(request.headers.authorization || "");
    if (!parsed.success) {
      return reply.code(401).send(withTenant("unknown", { error: "missing_bearer_token" }));
    }

    const token = parsed.data.replace(/^Bearer\s+/i, "").trim();
    try {
      request.auth = ctx.authService.verifyBearerToken(token);
      reply.header("x-tenant-id", request.auth.tenant_id);
    } catch {
      return reply.code(401).send(withTenant("unknown", { error: "invalid_bearer_token" }));
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
  const appendApiTrace = async (
    request: FastifyRequest,
    tenantId: string,
    jobId: string,
    event: string,
    level: "info" | "warn" | "error" = "info",
    payload?: Record<string, unknown>
  ): Promise<void> => {
    try {
      await ctx.traceStore.append({
        ts: new Date().toISOString(),
        source: "api",
        event,
        level,
        tenant_id: tenantId,
        job_id: jobId,
        req_id: request.id,
        payload
      });
    } catch (error) {
      request.log.warn(
        {
          event: "trace_append_failed",
          req_id: request.id,
          trace_event: event,
          tenant_id: tenantId,
          job_id: jobId,
          message: error instanceof Error ? error.message : String(error)
        },
        "trace append failed"
      );
    }
  };

  app.get("/healthz", async (_request, reply) => {
    const report = await ctx.llmHealthService.check();
    if (!report.ok) {
      reply.code(503);
    }
    reply.header("x-tenant-id", "system");
    return withTenant("system", report);
  });

  app.post("/v1/auth/exchange", async (request, reply) => {
    request.log.info(
      {
        event: "auth_exchange_start",
        req_id: request.id,
        auth_present: Boolean(request.headers.authorization)
      },
      "auth exchange start"
    );
    const authHeader = request.headers.authorization;
    const parsedBearer = bearerSchema.safeParse(Array.isArray(authHeader) ? authHeader[0] : authHeader || "");
    if (!parsedBearer.success) {
      return reply.code(400).send(withTenant("unknown", { error: "missing_bearer_authorization" }));
    }

    const sylKey = parsedBearer.data.replace(/^Bearer\s+/i, "").trim();
    if (!sylKey) {
      return reply.code(400).send(withTenant("unknown", { error: "missing_bearer_authorization" }));
    }

    try {
      const exchanged = ctx.authService.exchangeBySylKey(sylKey);
      request.log.info(
        {
          event: "auth_exchange_ok",
          req_id: request.id,
          tenant_id: exchanged.tenant_id,
          key_fingerprint: keyFingerprint(sylKey)
        },
        "auth exchange ok"
      );
      reply.header("x-tenant-id", exchanged.tenant_id);
      return exchanged;
    } catch {
      request.log.warn(
        {
          event: "auth_exchange_failed",
          req_id: request.id,
          key_fingerprint: keyFingerprint(sylKey)
        },
        "auth exchange failed"
      );
      return reply.code(401).send(withTenant("unknown", { error: "invalid_syl_key" }));
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
        return reply.code(400).send(withTenant(body.tenant_id, { error: msg }));
      }
      reply.header("x-tenant-id", body.tenant_id);
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
        return reply.code(400).send(withTenant(body.tenant_id, { error: msg }));
      }
      reply.header("x-tenant-id", body.tenant_id);
      return { ok: true, tenant_id: body.tenant_id, rules_version: body.rules_version };
    });

    adminApp.get("/v1/admin/logs/trace/:jobId", async (request, reply) => {
      const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(5000).optional(),
          offset: z.coerce.number().int().min(0).optional()
        })
        .parse(request.query);
      const limit = query.limit ?? 500;
      const offset = query.offset ?? 0;

      const record = await ctx.jobStore.get(params.jobId);
      if (!record) {
        return reply.code(404).send(withTenant("admin", { error: "job_not_found" }));
      }

      const [items, traceCount] = await Promise.all([
        ctx.traceStore.list(params.jobId, limit, offset),
        ctx.traceStore.count(params.jobId)
      ]);

      reply.header("x-tenant-id", record.tenant_id);
      return {
        ok: true,
        tenant_id: record.tenant_id,
        job_id: params.jobId,
        job_status: record.status,
        updated_at: record.updated_at,
        trace_count: traceCount,
        limit,
        offset,
        items
      };
    });
  });

  app.register(async (securedApp) => {
    securedApp.addHook("preHandler", requireAuth(ctx));

    securedApp.get("/v1/rules/resolve", async (request) => {
      const query = z.object({ current: z.string().optional() }).parse(request.query);
      const tenantId = request.auth!.tenant_id;
      const resolved = await ctx.rulesService.resolve(tenantId, query.current);
      resolved.download_url = `${requestBaseURL(request)}/v1/rules/download/${encodeURIComponent(tenantId)}/${encodeURIComponent(resolved.rules_version)}`;
      request.log.info(
        {
          event: "rules_resolve_ok",
          req_id: request.id,
          tenant_id: tenantId,
          current: query.current || "",
          rules_version: resolved.rules_version,
          up_to_date: resolved.up_to_date
        },
        "rules resolve ok"
      );
      return withTenant(tenantId, resolved);
    });

    securedApp.post("/v1/rules/refresh", async (request) => {
      const tenantId = request.auth!.tenant_id;
      const resolved = await ctx.rulesService.resolve(tenantId, undefined);
      resolved.download_url = `${requestBaseURL(request)}/v1/rules/download/${encodeURIComponent(tenantId)}/${encodeURIComponent(resolved.rules_version)}`;
      request.log.info(
        {
          event: "rules_refresh_ok",
          req_id: request.id,
          tenant_id: tenantId,
          rules_version: resolved.rules_version
        },
        "rules refresh ok"
      );
      return withTenant(tenantId, resolved);
    });

    securedApp.get("/v1/rules/download/:tenantId/:rulesVersion", async (request, reply) => {
      const params = z.object({ tenantId: z.string().min(1), rulesVersion: z.string().min(1) }).parse(request.params);
      const tenantId = request.auth!.tenant_id;
      if (tenantId !== params.tenantId) {
        return reply.code(403).send(withTenant(tenantId, { error: "tenant_mismatch" }));
      }
      try {
        const archive = await ctx.rulesService.readArchive(params.tenantId, params.rulesVersion);
        reply.header("x-tenant-id", tenantId);
        reply.header("Content-Type", "application/gzip");
        reply.header("Cache-Control", "no-store");
        return reply.send(archive);
      } catch {
        return reply.code(404).send(withTenant(tenantId, { error: "rules_archive_not_found" }));
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
      await appendApiTrace(request, tenantId, jobId, "generate_queued", "info", {
        candidate_count: candidateCount,
        input_chars: parsed.input_markdown.length,
        input_sha256: sha256Hex(parsed.input_markdown)
      });

      request.log.info(
        {
          event: "generate_queued",
          req_id: request.id,
          tenant_id: tenantId,
          job_id: jobId,
          candidate_count: candidateCount,
          input_chars: parsed.input_markdown.length,
          input_sha256: sha256Hex(parsed.input_markdown)
        },
        "generate queued"
      );

      return {
        job_id: jobId,
        status: "queued",
        tenant_id: tenantId
      };
    });

    securedApp.get("/v1/jobs/:jobId", async (request, reply) => {
      const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const tenantId = request.auth!.tenant_id;

      const record = await ctx.jobStore.get(params.jobId);
      if (!record || record.tenant_id !== tenantId) {
        return reply.code(404).send(withTenant(tenantId, { error: "job_not_found" }));
      }

      request.log.info(
        {
          event: "job_status_read",
          req_id: request.id,
          tenant_id: tenantId,
          job_id: record.id,
          status: record.status
        },
        "job status read"
      );
      await appendApiTrace(request, tenantId, record.id, "job_status_read", "info", {
        status: record.status
      });

      return {
        job_id: record.id,
        status: record.status,
        error: record.error_message || undefined,
        updated_at: record.updated_at,
        tenant_id: tenantId
      };
    });

    securedApp.get("/v1/jobs/:jobId/trace", async (request, reply) => {
      const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().positive().max(1000).optional(),
          offset: z.coerce.number().int().min(0).optional()
        })
        .parse(request.query);
      const tenantId = request.auth!.tenant_id;

      const record = await ctx.jobStore.get(params.jobId);
      if (!record || record.tenant_id !== tenantId) {
        return reply.code(404).send(withTenant(tenantId, { error: "job_not_found" }));
      }

      const limit = query.limit ?? 200;
      const offset = query.offset ?? 0;
      const [items, traceCount] = await Promise.all([
        ctx.traceStore.list(params.jobId, limit, offset),
        ctx.traceStore.count(params.jobId)
      ]);
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < traceCount;

      reply.header("x-tenant-id", tenantId);
      return {
        ok: true,
        tenant_id: tenantId,
        job_id: params.jobId,
        job_status: record.status,
        updated_at: record.updated_at,
        trace_count: traceCount,
        limit,
        offset,
        next_offset: nextOffset,
        has_more: hasMore,
        items
      };
    });

    securedApp.get("/v1/jobs/:jobId/result", async (request, reply) => {
      const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const tenantId = request.auth!.tenant_id;

      const record = await ctx.jobStore.get(params.jobId);
      if (!record || record.tenant_id !== tenantId) {
        return reply.code(404).send(withTenant(tenantId, { error: "job_not_found" }));
      }

      if (record.status !== "succeeded") {
        await appendApiTrace(request, tenantId, record.id, "job_result_not_ready", "warn", {
          status: record.status
        });
        return reply.code(409).send({
          error: "job_not_ready",
          status: record.status,
          message: "任务未完成，暂不可读取 result",
          tenant_id: tenantId
        });
      }

      const result = await ctx.jobStore.consumeResult(params.jobId);
      if (!result) {
        return reply.code(404).send(withTenant(tenantId, { error: "result_consumed_or_missing" }));
      }

      request.log.info(
        {
          event: "job_result_read",
          req_id: request.id,
          tenant_id: tenantId,
          job_id: params.jobId,
          en_chars: result.en_markdown.length,
          cn_chars: result.cn_markdown.length,
          timing_ms: result.timing_ms
        },
        "job result read"
      );
      await appendApiTrace(request, tenantId, params.jobId, "job_result_read", "info", {
        en_chars: result.en_markdown.length,
        cn_chars: result.cn_markdown.length,
        timing_ms: result.timing_ms
      });

      return withTenant(tenantId, result);
    });
  });
}
