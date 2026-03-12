import test from "node:test";
import assert from "node:assert/strict";
import { resolveLLMRuntime } from "./llm-runtime.js";
import type { AppEnv } from "../config/env.js";
import type { ModelProfile } from "../agent-runtime/types.js";

function createEnv(): AppEnv {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8080,
    logLevel: "info",
    redisUrl: "redis://127.0.0.1:6379",
    queueName: "jobs",
    workerConcurrency: 1,
    jwtSecret: "1234567890123456",
    jwtExpiresSeconds: 900,
    sylListingKeys: new Map([["k", "demo"]]),
    apiPublicBaseUrl: "http://127.0.0.1:8080",
    adminToken: "12345678",
    rulesFsDir: "/tmp/rules",
    bootstrapRulesTenant: "demo",
    bootstrapRulesVersion: "rules-demo",
    bootstrapRulesManifestSha256: "sha",
    bootstrapRulesSignatureBase64: "",
    bootstrapRulesSignatureAlgo: "ed25519",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekChatPath: "/chat/completions",
    deepseekApiKey: "deepseek-key",
    deepseekModel: "deepseek-chat",
    deepseekTemperature: 1.1,
    healthcheckLlmCacheSeconds: 300,
    healthcheckLlmTimeoutSeconds: 12,
    healthcheckLlmRetries: 2,
    retryBaseMs: 100,
    retryMaxMs: 1000,
    retryJitter: 0.1,
    jobTtlSeconds: 3600
  };
}

test("resolveLLMRuntime uses runtime profile model over env defaults", () => {
  const profile: ModelProfile = {
    id: "writer-deepseek-custom",
    provider: "deepseek",
    model: "deepseek-custom",
    purpose: "draft"
  };

  const runtime = resolveLLMRuntime(createEnv(), profile);

  assert.equal(runtime.provider, "deepseek");
  assert.equal(runtime.model, "deepseek-custom");
  assert.equal(runtime.requestURL, "https://api.deepseek.com/chat/completions");
  assert.equal(runtime.modelSettings.temperature, 1.1);
});

test("resolveLLMRuntime falls back to deepseek env defaults when no profile is provided", () => {
  const runtime = resolveLLMRuntime(createEnv());

  assert.equal(runtime.provider, "deepseek");
  assert.equal(runtime.model, "deepseek-chat");
  assert.equal(runtime.requestURL, "https://api.deepseek.com/chat/completions");
  assert.equal(runtime.modelSettings.temperature, 1.1);
});
