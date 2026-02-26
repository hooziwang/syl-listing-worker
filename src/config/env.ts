import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

loadDotenv();

const secretSchema = z.object({
  WORKER_CONFIG_FILE: z.string().optional(),
  JWT_SECRET: z.string().min(16, "JWT_SECRET 太短，至少 16 位"),
  SYL_LISTING_KEYS: z.string().min(1, "SYL_LISTING_KEYS 不能为空"),
  ADMIN_TOKEN: z.string().min(8, "ADMIN_TOKEN 太短"),
  FLUXCODE_API_KEY: z.string().min(1, "FLUXCODE_API_KEY 不能为空"),
  DEEPSEEK_API_KEY: z.string().min(1, "DEEPSEEK_API_KEY 不能为空"),
});

const fileSchema = z.object({
  server: z.object({
    domain: z.string().min(1, "config.server.domain 不能为空"),
    letsencrypt_email: z.string().default(""),
    node_env: z.enum(["development", "test", "production"]).default("production"),
    host: z.string().default("0.0.0.0"),
    port: z.number().int().positive().default(8080),
    log_level: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    api_public_base_url: z.string().url().default("http://127.0.0.1:8080")
  }),
  redis: z.object({
    url: z.string().default("redis://redis:6379")
  }),
  queue: z.object({
    name: z.string().default("syl_listing_jobs"),
    worker_concurrency: z.number().int().positive().default(10),
    job_ttl_seconds: z.number().int().positive().default(3600)
  }),
  auth: z.object({
    jwt_expires_seconds: z.number().int().positive().default(900)
  }),
  rules: z.object({
    fs_dir: z.string().default("/data/syl-listing/rules"),
    bootstrap: z.object({
      tenant: z.string().default("demo"),
      version: z.string().default("tenant-demo-v1"),
      manifest_sha256: z.string().default("demo_sha256"),
      signature_base64: z.string().default(""),
      signature_algo: z.string().default("ed25519")
    })
  }),
  providers: z.object({
    fluxcode: z.object({
      base_url: z.string().url().default("https://flux-code.cc"),
      responses_path: z.string().default("/v1/responses"),
      model: z.string().default("gpt-5.3-codex"),
      reasoning_effort: z.string().default("high"),
      temperature: z.number().min(0).max(2).default(1.2)
    }),
    deepseek: z.object({
      base_url: z.string().url().default("https://api.deepseek.com"),
      chat_path: z.string().default("/chat/completions"),
      model: z.string().default("deepseek-chat"),
      temperature: z.number().min(0).max(2).default(1.3)
    })
  }),
  healthcheck: z.object({
    llm: z.object({
      cache_seconds: z.number().int().positive().default(300),
      timeout_seconds: z.number().int().positive().default(12),
      retries: z.number().int().positive().default(2)
    })
  }),
  retry: z.object({
    base_ms: z.number().int().positive().default(400),
    max_ms: z.number().int().positive().default(8000),
    jitter: z.number().min(0).max(1).default(0.25)
  })
});

export interface AppEnv {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  redisUrl: string;
  queueName: string;
  workerConcurrency: number;
  jwtSecret: string;
  jwtExpiresSeconds: number;
  sylListingKeys: Map<string, string>;
  apiPublicBaseUrl: string;
  adminToken: string;
  rulesFsDir: string;
  bootstrapRulesTenant: string;
  bootstrapRulesVersion: string;
  bootstrapRulesManifestSha256: string;
  bootstrapRulesSignatureBase64: string;
  bootstrapRulesSignatureAlgo: string;
  fluxcodeBaseUrl: string;
  fluxcodeResponsesPath: string;
  fluxcodeApiKey: string;
  fluxcodeModel: string;
  fluxcodeReasoningEffort: string;
  fluxcodeTemperature: number;
  deepseekBaseUrl: string;
  deepseekChatPath: string;
  deepseekApiKey: string;
  deepseekModel: string;
  deepseekTemperature: number;
  healthcheckLlmCacheSeconds: number;
  healthcheckLlmTimeoutSeconds: number;
  healthcheckLlmRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  retryJitter: number;
  jobTtlSeconds: number;
}

function resolveConfigFilePath(raw: string | undefined): string {
  const fallback = "worker.config.json";
  const value = (raw || "").trim();
  if (value === "") {
    return join(process.cwd(), fallback);
  }
  if (isAbsolute(value)) {
    return value;
  }
  return join(process.cwd(), value);
}

function loadConfigFile(path: string): z.infer<typeof fileSchema> {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`读取配置文件失败: ${path} (${msg})`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`解析配置文件失败: ${path} (${msg})`);
  }
  return fileSchema.parse(json);
}

function parseTenantKeys(raw: string): Map<string, string> {
  const pairs = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const map = new Map<string, string>();
  for (const pair of pairs) {
    const index = pair.indexOf(":");
    if (index <= 0 || index === pair.length - 1) {
      throw new Error(`SYL_LISTING_KEYS 格式错误: ${pair}`);
    }
    const tenantId = pair.slice(0, index).trim();
    const key = pair.slice(index + 1).trim();
    map.set(key, tenantId);
  }

  if (map.size === 0) {
    throw new Error("SYL_LISTING_KEYS 解析结果为空");
  }

  return map;
}

export function loadEnv(): AppEnv {
  const secrets = secretSchema.parse(process.env);
  const configFilePath = resolveConfigFilePath(secrets.WORKER_CONFIG_FILE);
  const config = loadConfigFile(configFilePath);

  return {
    nodeEnv: config.server.node_env,
    host: config.server.host,
    port: config.server.port,
    logLevel: config.server.log_level,
    redisUrl: config.redis.url,
    queueName: config.queue.name,
    workerConcurrency: config.queue.worker_concurrency,
    jwtSecret: secrets.JWT_SECRET,
    jwtExpiresSeconds: config.auth.jwt_expires_seconds,
    sylListingKeys: parseTenantKeys(secrets.SYL_LISTING_KEYS),
    apiPublicBaseUrl: config.server.api_public_base_url,
    adminToken: secrets.ADMIN_TOKEN,
    rulesFsDir: config.rules.fs_dir,
    bootstrapRulesTenant: config.rules.bootstrap.tenant,
    bootstrapRulesVersion: config.rules.bootstrap.version,
    bootstrapRulesManifestSha256: config.rules.bootstrap.manifest_sha256,
    bootstrapRulesSignatureBase64: config.rules.bootstrap.signature_base64,
    bootstrapRulesSignatureAlgo: config.rules.bootstrap.signature_algo,
    fluxcodeBaseUrl: config.providers.fluxcode.base_url,
    fluxcodeResponsesPath: config.providers.fluxcode.responses_path,
    fluxcodeApiKey: secrets.FLUXCODE_API_KEY,
    fluxcodeModel: config.providers.fluxcode.model,
    fluxcodeReasoningEffort: config.providers.fluxcode.reasoning_effort,
    fluxcodeTemperature: config.providers.fluxcode.temperature,
    deepseekBaseUrl: config.providers.deepseek.base_url,
    deepseekChatPath: config.providers.deepseek.chat_path,
    deepseekApiKey: secrets.DEEPSEEK_API_KEY,
    deepseekModel: config.providers.deepseek.model,
    deepseekTemperature: config.providers.deepseek.temperature,
    healthcheckLlmCacheSeconds: config.healthcheck.llm.cache_seconds,
    healthcheckLlmTimeoutSeconds: config.healthcheck.llm.timeout_seconds,
    healthcheckLlmRetries: config.healthcheck.llm.retries,
    retryBaseMs: config.retry.base_ms,
    retryMaxMs: config.retry.max_ms,
    retryJitter: config.retry.jitter,
    jobTtlSeconds: config.queue.job_ttl_seconds
  };
}
