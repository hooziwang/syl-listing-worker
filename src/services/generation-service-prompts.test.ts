import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { GenerationService } from "./generation-service.js";
import type { AppEnv } from "../config/env.js";
import type { SectionRule } from "./rules-loader.js";

function makeEnv(): AppEnv {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8080,
    logLevel: "silent",
    redisUrl: "redis://127.0.0.1:6379",
    queueName: "test",
    workerConcurrency: 1,
    jwtSecret: "1234567890123456",
    jwtExpiresSeconds: 900,
    sylListingKeys: new Map([["key", "syl"]]),
    apiPublicBaseUrl: "https://worker.example.test",
    adminToken: "admin-token",
    rulesFsDir: "/tmp/rules",
    bootstrapRulesTenant: "syl",
    bootstrapRulesVersion: "rules-syl-test",
    bootstrapRulesManifestSha256: "sha256",
    bootstrapRulesSignatureBase64: "sig",
    bootstrapRulesSignatureAlgo: "rsa-sha256",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekChatPath: "/chat/completions",
    deepseekApiKey: "deepseek-key",
    deepseekModel: "deepseek-chat",
    deepseekTemperature: 0.7,
    healthcheckLlmCacheSeconds: 60,
    healthcheckLlmTimeoutSeconds: 10,
    healthcheckLlmRetries: 1,
    retryBaseMs: 200,
    retryMaxMs: 1000,
    retryJitter: 0,
    jobTtlSeconds: 3600
  };
}

function makeBulletsRule(): SectionRule {
  return {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 5,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      preferred_min_chars_per_line: 255,
      preferred_max_chars_per_line: 265,
      heading_min_words: 2,
      heading_max_words: 4,
      keyword_embedding: {
        enabled: true,
        min_total: 15,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true,
        lowercase: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 5
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };
}

function makeService(): GenerationService {
  return new GenerationService(
    makeEnv(),
    pino({ level: "silent" }),
    {
      async append() {}
    } as never,
    { tenantId: "syl", jobId: "job_test" }
  );
}

test("buildSectionSystemPrompt tells LLM that bold wrappers do not count toward length", () => {
  const service = makeService();
  const prompt = (service as any).buildSectionSystemPrompt(makeBulletsRule(), true) as string;

  assert.match(prompt, /连续的 2 个星号 \*\* 不计入字符数/);
});

test("buildWholeRepairSystemPrompt tells LLM that bold wrappers do not count toward length", () => {
  const service = makeService();
  const prompt = (service as any).buildWholeRepairSystemPrompt(makeBulletsRule(), true) as string;

  assert.match(prompt, /连续的 2 个星号 \*\* 不计入字符数/);
});

test("buildWholeRepairSystemPrompt tells bullets repairer to clear the hard 240-char floor instead of stopping in the 230s", () => {
  const service = makeService();
  const prompt = (service as any).buildWholeRepairSystemPrompt(makeBulletsRule(), true) as string;

  assert.match(prompt, /低于 240 字符的条目直接视为失败/);
  assert.match(prompt, /不要停在 230-239 这类仍会失败的长度/);
  assert.match(prompt, /至少补到 252 字符以上再停/);
});

test("buildBulletItemRepairSystemPrompt tells LLM to do a narrow visible-char patch instead of expanding the whole bullet", () => {
  const service = makeService();
  const prompt = (service as any).buildBulletItemRepairSystemPrompt(
    makeBulletsRule(),
    1,
    [
      "第2条长度不满足约束: 239（规则区间 [240,250]，容差区间 [240,300]）"
    ]
  ) as string;

  assert.match(prompt, /长度按可见字符计算/);
  assert.match(prompt, /连续的 2 个星号 \*\* 不计入长度/);
  assert.match(prompt, /本轮是补差修复，不是整条扩写/);
  assert.match(prompt, /把最终长度控制在 252-258 个可见字符/);
  assert.match(prompt, /即使差距很小也要至少净增 12-20 个可见字符/);
  assert.match(prompt, /不要只改小标题或替换同义词/);
  assert.match(prompt, /不要扩写到 280 个可见字符以上/);
});

test("buildBulletItemRepairSystemPrompt tells keyword-order repairs to make room instead of appending another clause", () => {
  const service = makeService();
  const prompt = (service as any).buildBulletItemRepairSystemPrompt(
    makeBulletsRule(),
    1,
    [
      "关键词顺序埋入不满足: 第6个关键词未按顺序原样出现: Paper Hanging Decorations"
    ]
  ) as string;

  assert.match(prompt, /如果缺少或乱序的是本条关键词，先删掉旧的场景串或泛化短语，给缺失关键词腾位/);
  assert.match(prompt, /不要在句尾直接追加缺失关键词或额外整句/);
});

test("buildSectionSystemPrompt keeps bullets hard minimum at 240 while exposing preferred 255-265 range", () => {
  const service = makeService();
  const prompt = (service as any).buildSectionSystemPrompt(makeBulletsRule(), true) as string;

  assert.match(prompt, /每行长度：规则\[240,250\]，容差\[240,300\]/);
  assert.match(prompt, /每条最佳落点 255-265 字符，略高于 250 字符更稳妥/);
  assert.doesNotMatch(prompt, /容差\[190,300\]/);
});
