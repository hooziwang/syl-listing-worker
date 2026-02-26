import { loadEnv } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { createRedisConnection } from "./queue/redis.js";
import { RulesService } from "./services/rules-service.js";
import { RedisJobStore } from "./store/job-store.js";
import { RedisTraceStore } from "./store/trace-store.js";
import { createJobRunner } from "./worker/runner.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedisConnection(env.redisUrl);
const store = new RedisJobStore(redis, env.jobTtlSeconds);
const traceStore = new RedisTraceStore(redis, env.jobTtlSeconds);
const rulesService = new RulesService(redis, env.rulesFsDir, env.apiPublicBaseUrl);

await rulesService.bootstrap({
  tenant_id: env.bootstrapRulesTenant,
  rules_version: env.bootstrapRulesVersion,
  manifest_sha256: env.bootstrapRulesManifestSha256,
  signature_base64: env.bootstrapRulesSignatureBase64,
  signature_algo: env.bootstrapRulesSignatureAlgo
});

const runner = createJobRunner(env, redis, store, traceStore, rulesService, logger);
logger.info({ event: "runner_started", queue: env.queueName, concurrency: env.workerConcurrency }, "runner started");

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "shutdown", signal }, "shutting down runner");
  await runner.close();
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
