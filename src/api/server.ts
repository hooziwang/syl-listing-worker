import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { registerRoutes } from "./routes.js";
import type { ApiContext } from "./types.js";

export async function buildApiServer(ctx: ApiContext) {
  const app = Fastify({
    logger: {
      level: ctx.env.logLevel
    },
    requestIdHeader: "x-request-id"
  });

  await app.register(cors, {
    origin: true
  });
  await app.register(sensible);

  app.addHook("onRequest", async (request) => {
    request.traceStartMs = Date.now();
  });

  app.addHook("onResponse", async (request, reply) => {
    const started = request.traceStartMs ?? Date.now();
    const durationMs = Date.now() - started;
    const tenantId =
      request.auth?.tenant_id ??
      (typeof reply.getHeader("x-tenant-id") === "string" ? String(reply.getHeader("x-tenant-id")) : "unknown");
    const params = (request.params as Record<string, unknown>) || {};
    const jobId = typeof params.jobId === "string" ? params.jobId : undefined;

    request.log.info(
      {
        event: "api_response",
        req_id: request.id,
        method: request.method,
        url: request.url,
        route: request.routeOptions.url,
        status_code: reply.statusCode,
        duration_ms: durationMs,
        tenant_id: tenantId,
        job_id: jobId
      },
      "api response"
    );
  });

  await registerRoutes(app, ctx);

  app.setErrorHandler((error, request, reply) => {
    const err = error as {
      validation?: unknown;
      message: string;
      statusCode?: number;
    };
    const tenantId = request.auth?.tenant_id ?? "unknown";

    if (err.validation) {
      request.log.warn(
        {
          event: "api_error",
          req_id: request.id,
          method: request.method,
          url: request.url,
          status_code: 400,
          tenant_id: tenantId,
          message: err.message
        },
        "validation error"
      );
      reply.status(400).send({
        error: "validation_error",
        message: err.message,
        tenant_id: tenantId
      });
      return;
    }

    const statusCode = err.statusCode ?? 500;
    request.log.error(
      {
        event: "api_error",
        req_id: request.id,
        method: request.method,
        url: request.url,
        status_code: statusCode,
        tenant_id: tenantId,
        message: err.message
      },
      "api error"
    );
    reply.status(statusCode).send({
      error: "internal_error",
      message: err.message,
      tenant_id: tenantId
    });
  });

  app.setNotFoundHandler((request, reply) => {
    const tenantId = request.auth?.tenant_id ?? "unknown";
    request.log.warn(
      {
        event: "api_not_found",
        req_id: request.id,
        method: request.method,
        url: request.url,
        tenant_id: tenantId
      },
      "route not found"
    );
    reply.status(404).send({
      error: "not_found",
      message: "route_not_found",
      tenant_id: tenantId
    });
  });

  return app;
}
