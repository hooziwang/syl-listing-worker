import { AuthService } from "./auth/service.js";
import { buildApiServer } from "./api/server.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { createJobQueue } from "./queue/jobs.js";
import { createRedisConnection } from "./queue/redis.js";
import { LLMHealthService } from "./services/llm-health.js";
import { RulesService } from "./services/rules-service.js";
import { RedisJobStore } from "./store/job-store.js";
import { RedisTraceStore } from "./store/trace-store.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedisConnection(env.redisUrl);

const authService = new AuthService(env.sylListingKeys, env.jwtSecret, env.jwtExpiresSeconds);
const llmHealthService = new LLMHealthService(env, logger);
const rulesService = new RulesService(redis, env.rulesFsDir, env.apiPublicBaseUrl);
const jobStore = new RedisJobStore(redis, env.jobTtlSeconds);
const traceStore = new RedisTraceStore(redis, env.jobTtlSeconds);
const queue = createJobQueue(env.queueName, redis);

await rulesService.bootstrap({
  tenant_id: env.bootstrapRulesTenant,
  rules_version: env.bootstrapRulesVersion,
  manifest_sha256: env.bootstrapRulesManifestSha256,
  signature_base64: env.bootstrapRulesSignatureBase64,
  signature_algo: env.bootstrapRulesSignatureAlgo
});

const app = await buildApiServer({
  env,
  authService,
  llmHealthService,
  rulesService,
  jobStore,
  traceStore,
  queue
});

try {
  await app.listen({
    host: env.host,
    port: env.port
  });
  logger.info({ event: "api_started", host: env.host, port: env.port }, "api started");
} catch (error) {
  logger.error({ event: "api_start_failed", error }, "failed to start api");
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "shutdown", signal }, "shutting down api");
  await app.close();
  await queue.close();
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
