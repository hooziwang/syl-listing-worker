import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  QUEUE_NAME: z.string().default("syl_listing_jobs"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  JWT_SECRET: z.string().min(16, "JWT_SECRET 太短，至少 16 位"),
  JWT_EXPIRES_SECONDS: z.coerce.number().int().positive().default(900),
  SYL_LISTING_KEYS: z.string().min(1, "SYL_LISTING_KEYS 不能为空"),
  API_PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8080"),
  ADMIN_TOKEN: z.string().min(8, "ADMIN_TOKEN 太短"),
  RULES_FS_DIR: z.string().default("/data/syl-listing/rules"),
  BOOTSTRAP_RULES_TENANT: z.string().default("demo"),
  BOOTSTRAP_RULES_VERSION: z.string().default("tenant-demo-v1"),
  BOOTSTRAP_RULES_MANIFEST_SHA256: z.string().default("demo_sha256"),
  BOOTSTRAP_RULES_SIGNATURE_BASE64: z.string().default(""),
  BOOTSTRAP_RULES_SIGNATURE_ALGO: z.string().default("ed25519"),
  FLUXCODE_BASE_URL: z.string().url().default("https://flux-code.cc"),
  FLUXCODE_RESPONSES_PATH: z.string().default("/v1/responses"),
  FLUXCODE_API_KEY: z.string().min(1, "FLUXCODE_API_KEY 不能为空"),
  FLUXCODE_MODEL: z.string().default("gpt-5.3-codex"),
  FLUXCODE_REASONING_EFFORT: z.string().default("high"),
  FLUXCODE_TEMPERATURE: z.coerce.number().min(0).max(2).default(1.2),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_CHAT_PATH: z.string().default("/chat/completions"),
  DEEPSEEK_API_KEY: z.string().min(1, "DEEPSEEK_API_KEY 不能为空"),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  DEEPSEEK_TEMPERATURE: z.coerce.number().min(0).max(2).default(1.3),
  RETRY_BASE_MS: z.coerce.number().int().positive().default(400),
  RETRY_MAX_MS: z.coerce.number().int().positive().default(8000),
  RETRY_JITTER: z.coerce.number().min(0).max(1).default(0.25),
  JOB_TTL_SECONDS: z.coerce.number().int().positive().default(3600)
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
  retryBaseMs: number;
  retryMaxMs: number;
  retryJitter: number;
  jobTtlSeconds: number;
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
  const parsed = schema.parse(process.env);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    redisUrl: parsed.REDIS_URL,
    queueName: parsed.QUEUE_NAME,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    jwtSecret: parsed.JWT_SECRET,
    jwtExpiresSeconds: parsed.JWT_EXPIRES_SECONDS,
    sylListingKeys: parseTenantKeys(parsed.SYL_LISTING_KEYS),
    apiPublicBaseUrl: parsed.API_PUBLIC_BASE_URL,
    adminToken: parsed.ADMIN_TOKEN,
    rulesFsDir: parsed.RULES_FS_DIR,
    bootstrapRulesTenant: parsed.BOOTSTRAP_RULES_TENANT,
    bootstrapRulesVersion: parsed.BOOTSTRAP_RULES_VERSION,
    bootstrapRulesManifestSha256: parsed.BOOTSTRAP_RULES_MANIFEST_SHA256,
    bootstrapRulesSignatureBase64: parsed.BOOTSTRAP_RULES_SIGNATURE_BASE64,
    bootstrapRulesSignatureAlgo: parsed.BOOTSTRAP_RULES_SIGNATURE_ALGO,
    fluxcodeBaseUrl: parsed.FLUXCODE_BASE_URL,
    fluxcodeResponsesPath: parsed.FLUXCODE_RESPONSES_PATH,
    fluxcodeApiKey: parsed.FLUXCODE_API_KEY,
    fluxcodeModel: parsed.FLUXCODE_MODEL,
    fluxcodeReasoningEffort: parsed.FLUXCODE_REASONING_EFFORT,
    fluxcodeTemperature: parsed.FLUXCODE_TEMPERATURE,
    deepseekBaseUrl: parsed.DEEPSEEK_BASE_URL,
    deepseekChatPath: parsed.DEEPSEEK_CHAT_PATH,
    deepseekApiKey: parsed.DEEPSEEK_API_KEY,
    deepseekModel: parsed.DEEPSEEK_MODEL,
    deepseekTemperature: parsed.DEEPSEEK_TEMPERATURE,
    retryBaseMs: parsed.RETRY_BASE_MS,
    retryMaxMs: parsed.RETRY_MAX_MS,
    retryJitter: parsed.RETRY_JITTER,
    jobTtlSeconds: parsed.JOB_TTL_SECONDS
  };
}
