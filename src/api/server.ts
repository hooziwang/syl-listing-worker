import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { registerRoutes } from "./routes.js";
import type { ApiContext } from "./types.js";

export async function buildApiServer(ctx: ApiContext) {
  const app = Fastify({
    logger: {
      level: ctx.env.logLevel
    }
  });

  await app.register(cors, {
    origin: true
  });
  await app.register(sensible);

  await registerRoutes(app, ctx);

  app.setErrorHandler((error, request, reply) => {
    const err = error as {
      validation?: unknown;
      message: string;
      statusCode?: number;
    };
    const tenantId = request.auth?.tenant_id ?? "unknown";

    if (err.validation) {
      reply.status(400).send({
        error: "validation_error",
        message: err.message,
        tenant_id: tenantId
      });
      return;
    }

    const statusCode = err.statusCode ?? 500;
    reply.status(statusCode).send({
      error: "internal_error",
      message: err.message,
      tenant_id: tenantId
    });
  });

  app.setNotFoundHandler((request, reply) => {
    const tenantId = request.auth?.tenant_id ?? "unknown";
    reply.status(404).send({
      error: "not_found",
      message: "route_not_found",
      tenant_id: tenantId
    });
  });

  return app;
}
