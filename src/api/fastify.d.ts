import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      tenant_id: string;
      scope: string;
    };
  }
}
