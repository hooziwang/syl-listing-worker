import assert from "node:assert/strict";
import test from "node:test";
import type { AppEnv } from "../config/env.js";
import { LLMClient } from "./llm-client.js";

function createEnv(): AppEnv {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8080,
    logLevel: "silent",
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
    healthcheckLlmRetries: 1,
    retryBaseMs: 1,
    retryMaxMs: 1,
    retryJitter: 0,
    jobTtlSeconds: 3600
  };
}

test("LLMClient translateText returns translated content through generic runtime path", async () => {
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {} as any,
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });
  (client as any).runAgentText = async (_runner: unknown, _agent: unknown, input: string) => `translated:${input}`;

  const result = await client.translateText("system", "hello", "translate_step", 1);

  assert.equal(result, "translated:hello");
});

test("generateSectionWithAgentTeam retries with previous validation feedback in prompt", async () => {
  const prompts: string[] = [];
  let runCount = 0;
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (_agent: unknown, input: string) => {
        prompts.push(input);
        runCount += 1;
        return {
          finalOutput: runCount === 1 ? "draft" : "fixed"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "bullets",
    step: "bullets_runtime_team_candidate_1",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    reviewerInstructions: "reviewer",
    repairInstructions: "repair",
    attempts: 2,
    validateContent: (content) => {
      if (content === "fixed") {
        return {
          ok: true,
          normalizedContent: content,
          errors: []
        };
      }
      return {
        ok: false,
        normalizedContent: content,
        errors: ["第1条长度不满足约束: 331（规则区间 [200,270]，容差区间 [170,300]）", "关键词顺序埋入不满足: 第6个关键词未按顺序原样出现: Paper Hanging Decorations"],
        repairGuidance: "修复指导:\n- 从第2条开始按既定关键词批次重写。"
      };
    }
  });

  assert.equal(result, "fixed");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], "原始任务提示");
  assert.match(prompts[1], /上轮校验失败/);
  assert.match(prompts[1], /第1条长度不满足约束/);
  assert.match(prompts[1], /关键词顺序埋入不满足/);
  assert.match(prompts[1], /修复指导/);
  assert.match(prompts[1], /从第2条开始按既定关键词批次重写/);
});

test("generateSectionWithAgentTeam logs normalized bullet lines for failed candidates", async () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const client = new LLMClient(
    createEnv(),
    {
      info() {},
      warn(payload: Record<string, unknown>) {
        warnings.push(payload);
      },
      error() {}
    } as any,
    {
      append(entry: { event: string; payload?: Record<string, unknown> }) {
        traces.push(entry);
        return Promise.resolve();
      }
    } as any,
    {
      tenantId: "syl",
      jobId: "job_test"
    }
  );
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async () => ({
        finalOutput: "Line 1 with **ceiling hanging decor**.\nLine 2 with **Classroom Decoration**."
      })
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  await assert.rejects(() =>
    client.generateSectionWithAgentTeam({
      section: "bullets",
      step: "bullets_runtime_team_candidate_1",
      userPrompt: "原始任务提示",
      writerInstructions: "writer",
      attempts: 1,
      validateContent: (content) => ({
        ok: false,
        normalizedContent: content,
        errors: ["关键词顺序埋入不满足: 第7个关键词未按顺序原样出现: ceiling hanging decor"]
      })
    })
  );

  const failureTrace = traces.find((entry) => entry.event === "agent_team_candidate_failed");
  assert.deepEqual(failureTrace?.payload?.candidate_lines, [
    "Line 1 with **ceiling hanging decor**.",
    "Line 2 with **Classroom Decoration**."
  ]);
  const warning = warnings.find((entry) => entry.event === "agent_team_candidate_failed");
  assert.deepEqual(warning?.candidate_lines, [
    "Line 1 with **ceiling hanging decor**.",
    "Line 2 with **Classroom Decoration**."
  ]);
});

test("generateSectionWithAgentTeam starts reviewer-free sections from writer agent", async () => {
  const agentNames: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, _input: string) => {
        agentNames.push(String(agent?.name ?? ""));
        return {
          finalOutput: "description content"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "description",
    step: "description_runtime_team_candidate_1",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    repairInstructions: "repair",
    attempts: 1,
    validateContent: (content) => ({
      ok: true,
      normalizedContent: content,
      errors: []
    })
  });

  assert.equal(result, "description content");
  assert.deepEqual(agentNames, ["writer_description_runtime_team_candidate_1"]);
});
