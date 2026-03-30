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
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        const agentName = String(agent?.name ?? "");
        if (agentName.startsWith("repairer_")) {
          return {
            finalOutput: "still-bad"
          };
        }
        if (prompts.length >= 2) {
          return {
            finalOutput: "fixed"
          };
        }
        return {
          finalOutput: "draft"
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

test("generateSectionWithAgentTeam falls back to repairer when writer exits with invalid content", async () => {
  const agentNames: string[] = [];
  const prompts: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        agentNames.push(String(agent?.name ?? ""));
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          return {
            finalOutput: "fixed"
          };
        }
        return {
          finalOutput: "draft"
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
    attempts: 1,
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
        errors: ["第1条长度不满足约束: 221（规则区间 [240,250]，容差区间 [240,300]）"],
        repairGuidance: "修复指导:\n- 第1条修复到 255-265 字符。"
      };
    }
  });

  assert.equal(result, "fixed");
  assert.deepEqual(agentNames, [
    "section_planner_bullets_runtime_team_candidate_1",
    "repairer_bullets_runtime_team_candidate_1",
    "repairer_bullets_runtime_team_candidate_1"
  ]);
  assert.equal(prompts[0], "原始任务提示");
  assert.match(prompts[1] ?? "", /当前候选内容/);
  assert.match(prompts[1] ?? "", /draft/);
  assert.match(prompts[1] ?? "", /第1条长度不满足约束/);
  assert.match(prompts[1] ?? "", /第1条修复到 255-265 字符/);
  assert.match(prompts[1] ?? "", /这是定量修复任务；优先最小改动，只修被指出的问题/);
  assert.match(prompts[1] ?? "", /当前可见长度 5/);
});

test("generateSectionWithAgentTeam repair fallback evaluates two candidates and picks the better repair result", async () => {
  const prompts: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          if (input.includes("修复候选#1")) {
            return { finalOutput: "still-too-short" };
          }
          if (input.includes("修复候选#2")) {
            return { finalOutput: "fixed" };
          }
        }
        return { finalOutput: "draft" };
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
    repairInstructions: "repair",
    attempts: 1,
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
        errors: ["第1条长度不满足约束: 221（规则区间 [240,250]，容差区间 [240,300]）"],
        repairGuidance: "修复指导:\n- 第1条修复到 255-265 字符。"
      };
    }
  });

  assert.equal(result, "fixed");
  assert.match(prompts[1] ?? "", /修复候选#1/);
  assert.match(prompts[2] ?? "", /修复候选#2/);
});

test("generateSectionWithAgentTeam uses repair fallback after reviewer path returns invalid content", async () => {
  const agentNames: string[] = [];
  const prompts: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        agentNames.push(String(agent?.name ?? ""));
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          return {
            finalOutput: "fixed"
          };
        }
        return {
          finalOutput: "still-bad"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "bullets",
    step: "bullets_runtime_team_candidate_2",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    reviewerInstructions: "reviewer",
    repairInstructions: "repair",
    attempts: 1,
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
        errors: ["第2条长度不满足约束: 231（规则区间 [240,250]，容差区间 [240,300]）"],
        repairGuidance: "修复指导:\n- 第2条修复到 255-265 字符。"
      };
    }
  });

  assert.equal(result, "fixed");
  assert.deepEqual(agentNames, [
    "section_planner_bullets_runtime_team_candidate_2",
    "repairer_bullets_runtime_team_candidate_2",
    "repairer_bullets_runtime_team_candidate_2"
  ]);
  assert.match(prompts[1] ?? "", /当前候选内容/);
  assert.match(prompts[1] ?? "", /still-bad/);
});

test("generateSectionWithAgentTeam feeds title-specific hard length guidance into repair fallback prompt", async () => {
  const prompts: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          return {
            finalOutput: "fixed title"
          };
        }
        return {
          finalOutput: "too long draft title"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "title",
    step: "title_runtime_team_candidate_1",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    repairInstructions: "repair",
    attempts: 1,
    validateContent: (content) => {
      if (content === "fixed title") {
        return {
          ok: true,
          normalizedContent: content,
          errors: []
        };
      }
      return {
        ok: false,
        normalizedContent: content,
        errors: ["长度不满足约束: 226（规则区间 [100,200]，容差区间 [80,220]）"],
        repairGuidance: [
          "修复指导:",
          "- 标题必须保持单行。",
          "- 总长度控制在 100-200 字符，绝不超过 220 字符。",
          "- 当前超出上限 6 字符。"
        ].join("\n")
      };
    }
  });

  assert.equal(result, "fixed title");
  assert.match(prompts[1] ?? "", /标题必须保持单行/);
  assert.match(prompts[1] ?? "", /绝不超过 220 字符/);
  assert.match(prompts[1] ?? "", /当前超出上限 6 字符/);
});

test("generateSectionWithAgentTeam feeds paragraph compression guidance into description repair fallback prompt", async () => {
  const prompts: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          return {
            finalOutput: "fixed description"
          };
        }
        return {
          finalOutput: "too long description"
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
    validateContent: (content) => {
      if (content === "fixed description") {
        return {
          ok: true,
          normalizedContent: content,
          errors: []
        };
      }
      return {
        ok: false,
        normalizedContent: content,
        errors: ["长度不满足约束: 750（规则区间 [700,740]，容差区间 [700,740]）"],
        repairGuidance: [
          "修复指导:",
          "- 固定输出 2 段，仅保留 1 个空行分段，不要拆成额外段落。",
          "- 整体长度控制在 700-740 字符，绝不超过 740 字符。",
          "- 当前超出上限 10 字符。",
          "- 第2段优先收敛到建议长度 340-370 字符；正文保持紧凑。"
        ].join("\n")
      };
    }
  });

  assert.equal(result, "fixed description");
  assert.match(prompts[1] ?? "", /绝不超过 740 字符/);
  assert.match(prompts[1] ?? "", /当前超出上限 10 字符/);
  assert.match(prompts[1] ?? "", /第2段优先收敛到建议长度 340-370 字符/);
});

test("generateSectionWithAgentTeam allows paragraph-level rewrite for severely overlong descriptions", async () => {
  const prompts: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          return {
            finalOutput: "fixed description"
          };
        }
        return {
          finalOutput: "too long description"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "description",
    step: "description_runtime_team_candidate_2",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    repairInstructions: "repair",
    attempts: 1,
    validateContent: (content) => {
      if (content === "fixed description") {
        return {
          ok: true,
          normalizedContent: content,
          errors: []
        };
      }
      return {
        ok: false,
        normalizedContent: content,
        errors: ["长度不满足约束: 1060（规则区间 [700,740]，容差区间 [700,740]）"],
        repairGuidance: [
          "修复指导:",
          "- 固定输出 2 段，仅保留 1 个空行分段，不要拆成额外段落。",
          "- 整体长度控制在 700-740 字符，绝不超过 740 字符。",
          "- 当前超出上限 320 字符。",
          "- 第2段优先收敛到建议长度 350-370 字符。"
        ].join("\n")
      };
    }
  });

  assert.equal(result, "fixed description");
  assert.match(prompts[1] ?? "", /这是结构化修复任务；必要时允许重写局部或整段/);
  assert.match(prompts[1] ?? "", /当前整体超长 320 字符；目标压回 700-740/);
  assert.match(prompts[1] ?? "", /优先落在 710-730/);
  assert.doesNotMatch(prompts[1] ?? "", /这是定量编辑任务，不是整条重写/);
});

test("generateSectionWithAgentTeam steers slightly short descriptions toward the safe interior range", async () => {
  const prompts: string[] = [];
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          return {
            finalOutput: "fixed description"
          };
        }
        return {
          finalOutput: "slightly short description"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "description",
    step: "description_runtime_team_candidate_3",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    repairInstructions: "repair",
    attempts: 1,
    validateContent: (content) => {
      if (content === "fixed description") {
        return {
          ok: true,
          normalizedContent: content,
          errors: []
        };
      }
      return {
        ok: false,
        normalizedContent: content,
        errors: ["长度不满足约束: 699（规则区间 [700,740]，容差区间 [700,740]）"],
        repairGuidance: [
          "修复指导:",
          "- 固定输出 2 段，仅保留 1 个空行分段，不要拆成额外段落。",
          "- 整体长度控制在 700-740 字符，绝不超过 740 字符。",
          "- 当前只差 1 字符。",
          "- 不要贴着边界收尾，补到区间中部更稳。"
        ].join("\n")
      };
    }
  });

  assert.equal(result, "fixed description");
  assert.match(prompts[1] ?? "", /当前只差 1 字符/);
  assert.match(prompts[1] ?? "", /优先落在 710-730/);
});

test("generateSectionWithAgentTeam can run a second repair fallback round before failing the whole section", async () => {
  const prompts: string[] = [];
  let repairRuns = 0;
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          repairRuns += 1;
          return {
            finalOutput: repairRuns <= 2 ? "still-too-long" : "fixed description"
          };
        }
        return {
          finalOutput: "too long description"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "description",
    step: "description_runtime_team_candidate_2",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    repairInstructions: "repair",
    attempts: 1,
    validateContent: (content) => {
      if (content === "fixed description") {
        return {
          ok: true,
          normalizedContent: content,
          errors: []
        };
      }
      if (content === "still-too-long") {
        return {
          ok: false,
          normalizedContent: content,
          errors: ["长度不满足约束: 768（规则区间 [700,740]，容差区间 [700,740]）"],
          repairGuidance: "修复指导:\n- 当前超出上限 28 字符。\n- 第2段继续压缩，删除非必要信息。"
        };
      }
      return {
        ok: false,
        normalizedContent: content,
        errors: ["长度不满足约束: 1091（规则区间 [700,740]，容差区间 [700,740]）"],
        repairGuidance: "修复指导:\n- 当前超出上限 351 字符。\n- 先整体压缩，再回看第2段。"
      };
    }
  });

  assert.equal(result, "fixed description");
  assert.equal(repairRuns, 4);
  assert.ok(prompts.some((prompt) => /当前超出上限 351 字符/.test(prompt)));
  assert.ok(prompts.some((prompt) => /当前超出上限 28 字符/.test(prompt)));
  assert.ok(prompts.some((prompt) => /第2段继续压缩/.test(prompt)));
});

test("generateSectionWithAgentTeam can run a third repair fallback round for description before succeeding", async () => {
  const prompts: string[] = [];
  let repairRuns = 0;
  const client = new LLMClient(createEnv(), {
    info() {},
    warn() {},
    error() {}
  } as any);
  (client as any).resolveGenerationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {
      run: async (agent: { name?: string }, input: string) => {
        prompts.push(input);
        if (String(agent?.name ?? "").startsWith("repairer_")) {
          repairRuns += 1;
          return {
            finalOutput: repairRuns <= 4 ? "still-too-long" : "fixed description"
          };
        }
        return {
          finalOutput: "too long description"
        };
      }
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "description",
    step: "description_runtime_team_candidate_4",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    repairInstructions: "repair",
    attempts: 1,
    validateContent: (content) => {
      if (content === "fixed description") {
        return {
          ok: true,
          normalizedContent: content,
          errors: []
        };
      }
      if (content === "still-too-long") {
        return {
          ok: false,
          normalizedContent: content,
          errors: ["长度不满足约束: 769（规则区间 [700,740]，容差区间 [700,740]）"],
          repairGuidance: "修复指导:\n- 当前超出上限 29 字符。\n- 优先删除重复信息和冗余铺陈。\n- 第2段继续压缩，删除非必要信息。"
        };
      }
      return {
        ok: false,
        normalizedContent: content,
        errors: ["长度不满足约束: 962（规则区间 [700,740]，容差区间 [700,740]）"],
        repairGuidance: "修复指导:\n- 当前整体超长，先压缩再润色。"
      };
    }
  });

  assert.equal(result, "fixed description");
  assert.equal(repairRuns, 6);
  assert.ok(prompts.some((prompt) => /优先删除重复信息和冗余铺陈/.test(prompt)));
  assert.ok(prompts.every((prompt) => !/前 \d+ 个关键词/.test(prompt)));
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

test("generateSectionWithAgentTeam logs normalized description paragraphs for failed candidates", async () => {
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
        finalOutput:
          "Paragraph 1 with **paper lanterns** and extra detail.\n\nParagraph 2 with **hanging paper lanterns** and extra detail."
      })
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  await assert.rejects(() =>
    client.generateSectionWithAgentTeam({
      section: "description",
      step: "description_runtime_team_candidate_1",
      userPrompt: "原始任务提示",
      writerInstructions: "writer",
      attempts: 1,
      validateContent: (content) => ({
        ok: false,
        normalizedContent: content,
        errors: ["长度不满足约束: 900（规则区间 [700,740]，容差区间 [700,740]）"]
      })
    })
  );

  const failureTrace = traces.find((entry) => entry.event === "agent_team_candidate_failed");
  assert.deepEqual(failureTrace?.payload?.candidate_paragraphs, [
    "Paragraph 1 with **paper lanterns** and extra detail.",
    "Paragraph 2 with **hanging paper lanterns** and extra detail."
  ]);
  const warning = warnings.find((entry) => entry.event === "agent_team_candidate_failed");
  assert.deepEqual(warning?.candidate_paragraphs, [
    "Paragraph 1 with **paper lanterns** and extra detail.",
    "Paragraph 2 with **hanging paper lanterns** and extra detail."
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

test("generateSectionWithAgentTeam emits lifecycle trace for controlled handoffs without in-team validation loops", async () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const infos: Array<Record<string, unknown>> = [];
  const client = new LLMClient(
    createEnv(),
    {
      info(payload: Record<string, unknown>) {
        infos.push(payload);
      },
      warn() {},
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
      run: async (entryAgent: {
        handoffs?: Array<{ handoffs?: unknown[]; tools?: Array<{ name?: string }> }>;
        emit: (event: string, ...args: unknown[]) => void;
      }) => {
        const planner = entryAgent as any;
        const writerHandoff = planner.handoffs?.[0] as any;
        const writer = writerHandoff?.agent ?? writerHandoff;
        const reviewerHandoff = writer.handoffs?.[0] as any;
        const reviewer = reviewerHandoff?.agent ?? reviewerHandoff;
        const runContext = {} as any;

        planner.emit("agent_start", runContext, []);
        planner.emit("agent_handoff", runContext, writer);
        planner.emit("agent_end", runContext, "handoff to writer");

        writer.emit("agent_start", runContext, []);
        writer.emit("agent_handoff", runContext, reviewer);
        writer.emit("agent_end", runContext, "handoff to reviewer");

        reviewer.emit("agent_start", runContext, []);
        reviewer.emit("agent_end", runContext, "final text");

        return {
          finalOutput: "final text"
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
    reviewerInstructions: "reviewer",
    repairInstructions: "repair",
    attempts: 1,
    validateContent: (content) => ({
      ok: true,
      normalizedContent: content,
      errors: []
    })
  });

  assert.equal(result, "final text");
  assert.deepEqual(
    traces
      .filter((entry) => entry.event.startsWith("agent_team_") && entry.event !== "agent_team_request")
      .map((entry) => entry.event),
    [
      "agent_team_turn_start",
      "agent_team_handoff",
      "agent_team_turn_end",
      "agent_team_turn_start",
      "agent_team_handoff",
      "agent_team_turn_end",
      "agent_team_turn_start",
      "agent_team_turn_end",
      "agent_team_ok"
    ]
  );
  const handoffTrace = traces.find((entry) => entry.event === "agent_team_handoff");
  assert.equal(handoffTrace?.payload?.from_agent, "section_planner_description_runtime_team_candidate_1");
  assert.equal(handoffTrace?.payload?.to_agent, "writer_description_runtime_team_candidate_1");
  assert.ok(infos.some((entry) => entry.event === "agent_team_turn_start"));
  assert.ok(infos.some((entry) => entry.event === "agent_team_handoff"));
  assert.ok(infos.every((entry) => entry.event !== "agent_team_tool_start"));
});

test("generateSectionWithAgentTeam reports visible chars in success trace output_chars", async () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const client = new LLMClient(
    createEnv(),
    {
      info() {},
      warn() {},
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
        finalOutput: "Colorful **paper lanterns** decor"
      })
    },
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });

  const result = await client.generateSectionWithAgentTeam({
    section: "title",
    step: "title_runtime_team_candidate_1",
    userPrompt: "原始任务提示",
    writerInstructions: "writer",
    attempts: 1,
    validateContent: (content) => ({
      ok: true,
      normalizedContent: content,
      errors: []
    })
  });

  assert.equal(result, "Colorful **paper lanterns** decor");
  const okTrace = traces.find((entry) => entry.event === "agent_team_ok");
  assert.equal(okTrace?.payload?.output_chars, "Colorful **paper lanterns** decor".replace(/\*\*/g, "").length);
});

test("generateText logger api_ok uses visible chars and keeps raw char counts", async () => {
  const infos: Array<Record<string, unknown>> = [];
  const client = new LLMClient(
    createEnv(),
    {
      info(payload: Record<string, unknown>) {
        infos.push(payload);
      },
      warn() {},
      error() {}
    } as any,
    {
      append() {
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
    runner: {} as any,
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });
  (client as any).runAgentText = async () => "Colorful **paper lanterns** decor";

  const result = await client.generateText("system", "user", "runtime_plan", 1, "planner");

  assert.equal(result, "Colorful **paper lanterns** decor");
  const apiOk = infos.find((entry) => entry.event === "api_ok");
  assert.equal(apiOk?.output_chars, "Colorful **paper lanterns** decor".replace(/\*\*/g, "").length);
  assert.equal(apiOk?.raw_output_chars, "Colorful **paper lanterns** decor".length);
});

test("translateText logger api_ok uses visible chars and keeps raw char counts", async () => {
  const infos: Array<Record<string, unknown>> = [];
  const client = new LLMClient(
    createEnv(),
    {
      info(payload: Record<string, unknown>) {
        infos.push(payload);
      },
      warn() {},
      error() {}
    } as any,
    {
      append() {
        return Promise.resolve();
      }
    } as any,
    {
      tenantId: "syl",
      jobId: "job_test"
    }
  );
  (client as any).resolveTranslationRuntime = () => ({
    generationProvider: "deepseek",
    runner: {} as any,
    model: "deepseek-chat",
    requestURL: "https://api.deepseek.com/chat/completions",
    modelSettings: { temperature: 1.1 }
  });
  (client as any).runAgentText = async () => "Translated **paper lanterns** decor";

  const result = await client.translateText("system", "user", "translate_title", 1);

  assert.equal(result, "Translated **paper lanterns** decor");
  const apiOk = infos.find((entry) => entry.event === "api_ok");
  assert.equal(apiOk?.output_chars, "Translated **paper lanterns** decor".replace(/\*\*/g, "").length);
  assert.equal(apiOk?.raw_output_chars, "Translated **paper lanterns** decor".length);
});
