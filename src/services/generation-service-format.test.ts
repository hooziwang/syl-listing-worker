import assert from "node:assert/strict";
import test from "node:test";
import type { AppEnv } from "../config/env.js";
import {
  adaptMarkdownContentForValidation,
  buildFallbackBulletLineForTest,
  buildTranslationReusePlanForTest,
  compactSectionRequirementsRawForPromptForTest,
  formatJSONArrayContent,
  pickSingleLineRepairCandidateForTest,
  resolveRuntimeTeamAttemptsForTest,
  resolveRuntimeTeamMaxTurnsForTest,
  shouldRunPromptPlanningForTest,
  scoreRuntimeCandidateForTest,
  summarizeRuntimeCandidateSelectionForTest
} from "./generation-service.js";
import { GenerationService } from "./generation-service.js";
import type { SectionRule, TenantRules } from "./rules-loader.js";

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

function createTenantRules(): TenantRules {
  return {
    requiredSections: ["translation"],
    input: {
      file_discovery: { marker: "# marker" },
      fields: []
    },
    generationConfig: {
      planning: {
        enabled: true,
        retries: 1,
        system_prompt: "plan",
        user_prompt: "{{requirements_raw}}"
      },
      judge: {
        enabled: false,
        max_rounds: 0,
        retries: 1,
        system_prompt: "",
        user_prompt: "",
        ignore_messages: [],
        skip_sections: []
      },
      translation: {
        system_prompt: "translate"
      },
      render: {
        keywords_item_template: "{{value}}",
        bullets_item_template: "{{value}}",
        bullets_separator: "\n"
      },
      display_labels: {}
    },
    templates: {
      en: "",
      cn: ""
    },
    sections: new Map()
  };
}

const schoolScenePattern =
  /\b(?:classroom|school|teacher|teachers|student|students|lesson|lessons|homeroom|hallway|hallways|bulletin board|reading corner|welcome board)\b/i;

test("formatJSONArrayContent emits the required JSON object shape for bullets output", () => {
  const result = formatJSONArrayContent(
    [
      "Package Contents: line one.",
      "Dimensions: line two."
    ].join("\n"),
    "bullets"
  );

  assert.deepEqual(JSON.parse(result), {
    bullets: [
      "Package Contents: line one.",
      "Dimensions: line two."
    ]
  });
});

test("adaptMarkdownContentForValidation merges extra paragraphs and closes sentence endings", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 2,
      max_paragraphs: 2,
      require_complete_sentence_end: true
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 5,
      paragraph_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const result = adaptMarkdownContentForValidation(
    "First paragraph without end\n\nSecond paragraph stays.\n\nThird paragraph joins",
    rule
  );

  assert.equal(result.content, "First paragraph without end.\n\nSecond paragraph stays. Third paragraph joins.");
});

test("adaptMarkdownContentForValidation strips agent meta preamble before description content", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 1,
      max_paragraphs: 2,
      require_complete_sentence_end: true
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const result = adaptMarkdownContentForValidation(
    "完美！校验通过，现在输出最终内容。\n\nActual description paragraph.",
    rule
  );

  assert.equal(result.content, "Actual description paragraph.");
});

test("scoreRuntimeCandidateForTest keeps normalized bullets text instead of re-parsing it as JSON", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 2,
      min_chars_per_line: 1,
      max_chars_per_line: 400
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    "Package Contents: line one.\nDimensions: line two."
  );

  assert.equal(result.normalizedContent, "Package Contents: line one.\nDimensions: line two.");
});

test("summarizeRuntimeCandidateSelectionForTest keeps candidate indexes and selected winner for trace output", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 10,
      max_chars: 20
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const summary = summarizeRuntimeCandidateSelectionForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    [
      { candidateIndex: 2, content: "Colorful Paper Lanterns" },
      { candidateIndex: 5, content: "Paper Lanterns" }
    ]
  );

  assert.equal(summary.selected_candidate_index, 5);
  assert.equal(summary.candidates[0]?.candidate_index, 2);
  assert.equal(summary.candidates[1]?.candidate_index, 5);
  assert.equal(summary.candidates[1]?.selected, true);
  assert.equal(summary.candidates[1]?.error_count, 0);
});

test("summarizeRuntimeCandidateSelectionForTest reports normalized_chars as visible chars", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 10,
      max_chars: 40
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const content = "Colorful **paper lanterns** decor";
  const summary = summarizeRuntimeCandidateSelectionForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    [{ candidateIndex: 1, content }]
  );

  assert.equal(summary.candidates[0]?.normalized_chars, content.replace(/\*\*/g, "").length);
});

test("summarizeRuntimeCandidateSelectionForTest keeps failed candidates with failure reasons in trace output", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 10,
      max_chars_per_line: 300
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const summary = summarizeRuntimeCandidateSelectionForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    [
      { candidateIndex: 1, error: "第2条长度不满足约束: 235" },
      { candidateIndex: 2, content: "Feature Focus: colorful paper lanterns for classroom decor." }
    ]
  );

  assert.equal(summary.selected_candidate_index, 2);
  assert.equal(summary.candidates[0]?.candidate_index, 1);
  assert.equal(summary.candidates[0]?.failure_reason, "第2条长度不满足约束: 235");
  assert.equal(summary.candidates[0]?.selected, false);
  assert.equal(summary.candidates[1]?.candidate_index, 2);
  assert.equal(summary.candidates[1]?.selected, true);
});

test("GenerationService translation trace uses visible chars and keeps raw char counts", async () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const infos: Array<Record<string, unknown>> = [];
  const service = new GenerationService(
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
  (service as any).currentRules = createTenantRules();
  (service as any).llmClient = {
    translateWithTranslatorAgent: async () => "Translated **paper lanterns** decor"
  };

  const input = "Source **paper lanterns** text";
  const result = await (service as any).translateTextWithProfile(input, "translate_description", 1);

  assert.equal(result, "Translated **paper lanterns** decor");
  const startTrace = traces.find((entry) => entry.event === "translation_start");
  assert.equal(startTrace?.payload?.input_chars, input.replace(/\*\*/g, "").length);
  assert.equal(startTrace?.payload?.raw_input_chars, input.length);
  const okTrace = traces.find((entry) => entry.event === "translation_ok");
  assert.equal(okTrace?.payload?.output_chars, "Translated **paper lanterns** decor".replace(/\*\*/g, "").length);
  assert.equal(okTrace?.payload?.raw_output_chars, "Translated **paper lanterns** decor".length);
  const startInfo = infos.find((entry) => entry.event === "translation_start");
  assert.equal(startInfo?.input_chars, input.replace(/\*\*/g, "").length);
  assert.equal(startInfo?.raw_input_chars, input.length);
  const okInfo = infos.find((entry) => entry.event === "translation_ok");
  assert.equal(okInfo?.output_chars, "Translated **paper lanterns** decor".replace(/\*\*/g, "").length);
  assert.equal(okInfo?.raw_output_chars, "Translated **paper lanterns** decor".length);
});

test("scoreRuntimeCandidateForTest tolerates trailing prose after bullets JSON output", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 2,
      min_chars_per_line: 1,
      max_chars_per_line: 400
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    `${JSON.stringify({
      bullets: [
        "Package Contents: line one.",
        "Dimensions: line two."
      ]
    })}\n\n这些是最终内容。`
  );

  assert.equal(result.normalizedContent, "Package Contents: line one.\nDimensions: line two.");
});

test("scoreRuntimeCandidateForTest lightly compresses borderline overlong bullet lines before validation", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 1,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Package Contents: This set includes 12 premium durable versatile **Paper Lanterns** designed for versatile decorative use. Our **Paper Lanterns Decorative** collection features durable construction, and these vibrant **Colorful Paper Lanterns** are perfect for creating vibrant displays in various settings with easy assembly.";

  assert.ok(rawLine.length > 300);

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns Decorative\*\*/);
  assert.match(result.normalizedContent, /\*\*Colorful Paper Lanterns\*\*/);
});

test("scoreRuntimeCandidateForTest ignores bold wrappers when validating bullet line length", () => {
  const line = "Feature Focus: **paper lanterns** brighten classroom displays fast.";
  const visibleLength = line.replace(/\*\*/g, "").length;
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: visibleLength,
      max_chars_per_line: visibleLength
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({ bullets: [line] })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
});

test("scoreRuntimeCandidateForTest prefers bullets candidates slightly above 250 over mid-240s", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      preferred_min_chars_per_line: 255,
      preferred_max_chars_per_line: 265
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };
  const requirements = {
    brand: "gisgfim",
    category: "Paper Lanterns",
    keywords: [],
    raw: "# raw",
    values: {}
  };
  const shorter = `Value Focus: ${"a".repeat(233)}.`;
  const preferred = `Value Focus: ${"b".repeat(248)}.`;

  assert.equal(shorter.length, 247);
  assert.equal(preferred.length, 262);

  const shorterResult = scoreRuntimeCandidateForTest(
    requirements,
    rule,
    JSON.stringify({ bullets: [shorter] })
  );
  const preferredResult = scoreRuntimeCandidateForTest(
    requirements,
    rule,
    JSON.stringify({ bullets: [preferred] })
  );

  assert.equal(shorterResult.errors.length, 0);
  assert.equal(preferredResult.errors.length, 0);
  assert.ok(preferredResult.score < shorterResult.score);
});

test("pickSingleLineRepairCandidateForTest ignores echoed short line and picks the repaired longer line", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      preferred_min_chars_per_line: 255,
      preferred_max_chars_per_line: 265
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };
  const originalLine = `Feature Focus: ${"a".repeat(220)}.`;
  const repairedLine = `Feature Focus: ${"b".repeat(248)}.`;

  const picked = pickSingleLineRepairCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    [originalLine],
    0,
    [originalLine, repairedLine].join("\n")
  );

  assert.equal(picked.line, repairedLine);
  assert.deepEqual(picked.relevantErrors, []);
});

test("buildFallbackBulletLineForTest keeps every underlength bullet fallback above the hard 240-char floor", () => {
  const sourceLines = [
    "Package Contents: This package includes 12 **paper lanterns** in 10x10 inches for classroom displays and party decor. **paper lanterns decorative** keep setup simple, and **colorful paper lanterns** brighten welcome walls, tables, and reading corners with plaid color and reusable style for daily school use.",
    "Installation Ready: These **hanging paper lanterns** open quickly for ceilings and walls in busy classrooms with easy setup and no tools. **hanging decor** saves teacher time, and **paper hanging decorations** add layered color for welcome days, party tables, reading corners, and bulletin board backdrops.",
    "Reusable Storage: These **ceiling hanging decor** pieces fold flat for storage and reuse after lessons, school events, and seasonal decorating. **hanging ceiling decor** keeps setup practical, and **classroom decoration** helps displays stay neat for the next celebration.",
    "Plaid Classroom Style: This **hanging classroom decoration** adds plaid color that brightens school spaces during welcome weeks, class parties, and craft days. **ceiling hanging classroom decor** keeps focal points clear, and **wedding decorations** styling helps tables, doors, and corners look neat in shared spaces.",
    "Versatile Decor Uses: These **chinese lanterns** fit classroom celebrations, reading corners, bulletin boards, and themed tables while staying light and easy to move. **ball lanterns lamps** add soft impact, and **summer party decorations** support seasonal refreshes and reusable school events."
  ];

  for (const [index, line] of sourceLines.entries()) {
    const fallback = buildFallbackBulletLineForTest(line, index);
    const visible = fallback.replace(/\*\*/g, "").length;
    assert.ok(visible >= 240, `fallback ${index + 1} too short: ${visible} chars, line=${fallback}`);
  }
});

test("buildFallbackBulletLineForTest does not inject classroom scenes for unrelated products", () => {
  const line =
    "Package Value: Includes 6 **bath towels** in 27x54 inches with soft cotton comfort. **bath towel set** keeps daily rotation simple, and **bathroom towels** add reliable drying value for guest baths, master baths, apartments, hotels, spas, travel kits, backup storage, and everyday family routines with easy restocking.";

  const fallback = buildFallbackBulletLineForTest(line, 0);
  const visible = fallback.replace(/\*\*/g, "").length;

  assert.match(fallback, /\*\*bath towels\*\*/);
  assert.match(fallback, /\*\*bath towel set\*\*/);
  assert.match(fallback, /\*\*bathroom towels\*\*/);
  assert.doesNotMatch(fallback, schoolScenePattern);
  assert.ok(visible >= 240, `fallback too short: ${visible} chars, line=${fallback}`);
  assert.ok(visible <= 300, `fallback too long: ${visible} chars, line=${fallback}`);
});

test("scoreRuntimeCandidateForTest ignores bold wrappers when validating title length", () => {
  const title = "Colorful **paper lanterns** decor set";
  const visibleLength = title.replace(/\*\*/g, "").length;
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: visibleLength,
      max_chars: visibleLength
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    title
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
});

test("scoreRuntimeCandidateForTest compresses borderline overlong description content before validation", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 2,
      max_paragraphs: 2,
      min_chars: 700,
      max_chars: 740,
      tolerance_chars: 0,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 6,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 5,
      paragraph_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const raw = [
    "These **paper lanterns** give classrooms a bright plaid focal point for welcome walls, bulletin boards, reading corners, seasonal craft tables, and first week displays. The **paper lanterns decorative** finish keeps displays cheerful and photo ready, while **colorful paper lanterns** spread coordinated color through daily lessons, themed parties, teacher prepared event corners, and seasonal hallway displays.",
    "",
    "Lightweight frames open quickly and fold flat after use, so **hanging paper lanterns** stay practical for repeated school decorating. **hanging decor** helps teachers refresh ceilings and doorways without extra tools, and **paper hanging decorations** keep party areas, hallway displays, classroom celebrations, reading stations, and entry corners neat, colorful, and easy to reset."
  ].join("\n");

  const rawVisibleLength = raw.replace(/\*\*/g, "").length;
  assert.equal(rawVisibleLength, 771);

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "paper lanterns",
        "paper lanterns decorative",
        "colorful paper lanterns",
        "hanging paper lanterns",
        "hanging decor",
        "paper hanging decorations"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    raw
  );

  const normalizedVisibleLength = result.normalizedContent.replace(/\*\*/g, "").length;
  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(normalizedVisibleLength >= 700, `description too short after compression: ${normalizedVisibleLength}`);
  assert.ok(normalizedVisibleLength <= 740, `description still too long after compression: ${normalizedVisibleLength}`);
  assert.match(result.normalizedContent, /\*\*paper lanterns\*\*/i);
  assert.match(result.normalizedContent, /\*\*paper lanterns decorative\*\*/i);
  assert.match(result.normalizedContent, /\*\*colorful paper lanterns\*\*/i);
  assert.match(result.normalizedContent, /\*\*hanging paper lanterns\*\*/i);
  assert.match(result.normalizedContent, /\*\*hanging decor\*\*/i);
  assert.match(result.normalizedContent, /\*\*paper hanging decorations\*\*/i);
});

test("scoreRuntimeCandidateForTest trims strongly overlong description content without breaking bold keyword spacing", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 2,
      max_paragraphs: 2,
      min_chars: 700,
      max_chars: 740,
      tolerance_chars: 0,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 6,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 5,
      paragraph_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const raw = [
    "These **paper lanterns** give classrooms a bright plaid focal point for welcome walls, bulletin boards, reading corners, seasonal craft tables, and first week displays. The **paper lanterns decorative** finish keeps displays cheerful and photo ready, while **colorful paper lanterns** spread coordinated color through daily lessons, themed parties, teacher prepared event corners, and seasonal hallway displays. Teachers also get a polished backdrop for first day photos and homeroom showcases that looks coordinated from every angle.",
    "",
    "Lightweight frames open quickly and fold flat after use, so **hanging paper lanterns** stay practical for repeated school decorating. **hanging decor** helps teachers refresh ceilings and doorways without extra tools, and **paper hanging decorations** keep party areas, hallway displays, classroom celebrations, reading stations, and entry corners neat, colorful, and easy to reset. The reusable build keeps cleanup simple after events and helps staff refresh the room again without buying extra decor."
  ].join("\n");

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "paper lanterns",
        "paper lanterns decorative",
        "colorful paper lanterns",
        "hanging paper lanterns",
        "hanging decor",
        "paper hanging decorations"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    raw
  );

  const normalizedVisibleLength = result.normalizedContent.replace(/\*\*/g, "").length;
  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(result.errors.filter((item) => item.includes("关键词顺序埋入不满足")).length, 0);
  assert.ok(normalizedVisibleLength >= 700, `description too short after stronger compression: ${normalizedVisibleLength}`);
  assert.ok(normalizedVisibleLength <= 740, `description still too long after stronger compression: ${normalizedVisibleLength}`);
  assert.match(result.normalizedContent, /\*\*paper lanterns\*\*\s+[A-Za-z]/);
  assert.match(result.normalizedContent, /\*\*colorful paper lanterns\*\*\s+[A-Za-z]/);
  assert.match(result.normalizedContent, /\*\*paper hanging decorations\*\*\s+[A-Za-z]/);
});

test("scoreRuntimeCandidateForTest compresses runtime-style generic description boilerplate with dense keyword coverage", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 2,
      max_paragraphs: 2,
      min_chars: 700,
      max_chars: 740,
      tolerance_chars: 0,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 15,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 5,
      paragraph_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const raw = [
    "Elevate any space with our versatile set of twelve **Paper Lanterns**, perfect for creating a festive and personalized atmosphere. These **Paper Lanterns Decorative** pieces are designed as **Colorful Paper Lanterns** featuring a vibrant plaid pattern, measuring 10x10 inches each for a substantial visual impact. Ideal as **hanging paper lanterns** or **Hanging Decor**, these charming **Paper Hanging Decorations** help classrooms, parties, and welcome walls feel bright and polished.",
    "",
    "This pack is exceptionally suited for **Classroom Decoration**, providing an engaging **Hanging Classroom Decoration** solution for inspiring **ceiling hanging Classroom decor**. As classic **chinese lanterns** or **Ball Lanterns Lamps**, they also adapt beautifully for elegant **wedding decorations** or vibrant **summer party decorations**. The set also works as **hanging decor from ceiling** for events and **baby shower decorations** in classrooms and party tables."
  ].join("\n");

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns",
        "hanging paper lanterns",
        "Hanging Decor",
        "Paper Hanging Decorations",
        "Classroom Decoration",
        "Hanging Classroom Decoration",
        "ceiling hanging Classroom decor",
        "chinese lanterns",
        "Ball Lanterns Lamps",
        "wedding decorations",
        "summer party decorations",
        "hanging decor from ceiling",
        "baby shower decorations"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    raw
  );

  const normalizedVisibleLength = result.normalizedContent.replace(/\*\*/g, "").length;
  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(result.errors.filter((item) => item.includes("关键词顺序埋入不满足")).length, 0);
  assert.ok(normalizedVisibleLength >= 700, `runtime-style description too short after compression: ${normalizedVisibleLength}`);
  assert.ok(normalizedVisibleLength <= 740, `runtime-style description still too long after compression: ${normalizedVisibleLength}`);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(result.normalizedContent, /\*\*baby shower decorations\*\*/);
});

test("scoreRuntimeCandidateForTest rebuilds severely overlong runtime-style description into a valid fallback", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 2,
      max_paragraphs: 2,
      min_chars: 700,
      max_chars: 740,
      tolerance_chars: 0,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 15,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 5,
      paragraph_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const raw = [
    "Brighten any room with this versatile set of twelve **Paper Lanterns**, perfect for creating a festive atmosphere. Each **Paper Lanterns Decorative** piece measures 10 inches, offering visual impact for your projects. These vibrant **Colorful Paper Lanterns** feature an eye-catching plaid design, ready to be used as elegant **hanging paper lanterns** for dynamic **Hanging Decor** in classrooms, parties, welcome walls, bulletin boards, reading corners, and event backdrops. Crafted as durable **Paper Hanging Decorations**, they assemble easily for reuse as stunning **ceiling hanging decor** or **hanging ceiling decor** across seasonal displays and celebratory moments.",
    "",
    "This collection is excellent for **Classroom Decoration**, providing a stimulating **Hanging Classroom Decoration** environment. Create an engaging **ceiling hanging Classroom decor** setup or repurpose them for other occasions like festive **wedding decorations** or as traditional **chinese lanterns**. These delightful **Ball Lanterns Lamps** also create a cheerful look for **summer party decorations**, helping teachers and families build photo-ready spaces with endless DIY possibilities and reusable decorating flexibility."
  ].join("\n");

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns",
        "hanging paper lanterns",
        "Hanging Decor",
        "Paper Hanging Decorations",
        "ceiling hanging decor",
        "hanging ceiling decor",
        "Classroom Decoration",
        "Hanging Classroom Decoration",
        "ceiling hanging Classroom decor",
        "wedding decorations",
        "chinese lanterns",
        "Ball Lanterns Lamps",
        "summer party decorations"
      ],
      raw: [
        "# 基础信息",
        "数量/包装:12 个",
        "颜色:Colorful plaid",
        "尺寸:10*10in",
        "",
        "# 特殊关键要求",
        "适用场景最主要是教室悬挂装饰"
      ].join("\n"),
      values: {}
    },
    rule,
    raw
  );

  const normalizedVisibleLength = result.normalizedContent.replace(/\*\*/g, "").length;
  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(result.errors.filter((item) => item.includes("关键词顺序埋入不满足")).length, 0);
  assert.ok(normalizedVisibleLength >= 700, `description too short after fallback rebuild: ${normalizedVisibleLength}`);
  assert.ok(normalizedVisibleLength <= 740, `description still too long after fallback rebuild: ${normalizedVisibleLength}`);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(result.normalizedContent, /\*\*summer party decorations\*\*/);
});

test("scoreRuntimeCandidateForTest rebuilds overlong bathroom description without injecting classroom scenes", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 2,
      max_paragraphs: 2,
      min_chars: 700,
      max_chars: 740,
      tolerance_chars: 0,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 15,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 5,
      paragraph_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const raw = [
    "These **bath towels** bring soft comfort and thick coverage to bathrooms, guest spaces, apartments, shared homes, travel bags, gym lockers, pool days, beach trips, cabin stays, daily family routines, and every kind of indoor and outdoor cleanup you can imagine with long lasting convenience and decorative styling that keeps sounding fuller and fuller for testing.",
    "",
    "The **bath towel set** gives households flexible rotation, and **bathroom towels** support drying after showers, baths, hand washing, sink splashes, countertop cleanup, mirror wipe downs, vanity touchups, hair care, skincare, kids cleanup, pet cleanup, guest refreshes, and endless daily household moments with more and more filler added to keep this paragraph overly long for the fallback path.",
    "",
    "These **cotton bath towels**, **soft bath towels**, **absorbent towels**, **quick dry towels**, **guest bathroom towels**, **luxury bath towels**, **spa towels**, **hotel towels**, **large bath towels**, **bath sheet towels**, **family bath towels**, and **plush towels** stay useful for bathrooms, showers, tubs, vanities, counters, closets, laundry rooms, weekend hosting, and routine restocking while this intentionally oversized paragraph keeps going far beyond the configured limit so the repair fallback has to intervene instead of simply validating the original text as acceptable."
  ].join("\n");

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "SoftHome",
      category: "Home & Kitchen > Bath > Towels > Bath Towels",
      keywords: [
        "bath towels",
        "bath towel set",
        "bathroom towels",
        "cotton bath towels",
        "soft bath towels",
        "absorbent towels",
        "quick dry towels",
        "guest bathroom towels",
        "luxury bath towels",
        "spa towels",
        "hotel towels",
        "large bath towels",
        "bath sheet towels",
        "family bath towels",
        "plush towels"
      ],
      raw: [
        "# 基础信息",
        "品牌名: SoftHome",
        "",
        "# 分类",
        "Home & Kitchen > Bath > Towels > Bath Towels",
        "",
        "# 特殊关键要求",
        "主要用于浴室、淋浴后擦干和日常家用，不要出现学校、教室、派对场景"
      ].join("\n"),
      values: {}
    },
    rule,
    raw
  );

  const normalizedVisibleLength = result.normalizedContent.replace(/\*\*/g, "").length;
  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(result.errors.filter((item) => item.includes("关键词顺序埋入不满足")).length, 0);
  assert.ok(normalizedVisibleLength >= 700, `description too short after fallback rebuild: ${normalizedVisibleLength}`);
  assert.ok(normalizedVisibleLength <= 740, `description still too long after fallback rebuild: ${normalizedVisibleLength}`);
  assert.doesNotMatch(result.normalizedContent, schoolScenePattern);
  assert.match(result.normalizedContent, /\*\*bath towels\*\*/);
  assert.match(result.normalizedContent, /\*\*plush towels\*\*/);
});

test("scoreRuntimeCandidateForTest reports visible length without bold wrappers in errors", () => {
  const title = "Colorful **paper lanterns** decor set";
  const visibleLength = title.replace(/\*\*/g, "").length;
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 1,
      max_chars: visibleLength - 1
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    title
  );

  assert.ok(result.errors.some((item) => item.includes(`长度不满足约束: ${visibleLength}`)));
});

test("scoreRuntimeCandidateForTest compresses real-world filler phrases in slightly overlong classroom bullet lines", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Color: Featuring a vibrant colorful plaid pattern that adds visual appeal to any setting, these lanterns serve as beautiful **Hanging Classroom Decoration** elements. They function effectively as **ceiling hanging Classroom decor** and also work well for **wedding decorations** events, parties, and classroom displays.";

  assert.equal(rawLine.length, 319);

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*Hanging Classroom Decoration\*\*/);
  assert.match(result.normalizedContent, /\*\*ceiling hanging Classroom decor\*\*/);
  assert.match(result.normalizedContent, /\*\*wedding decorations\*\*/);
});

test("scoreRuntimeCandidateForTest compresses package and dimensions bullet patterns seen in runtime failure logs", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const packageLine =
    "Package Contents: The 12-pack of **Paper Lanterns** includes everything you need for immediate use, providing a complete set of **Paper Lanterns Decorative** items that are ready to transform any space. These **Colorful Paper Lanterns** create a cheerful display for classrooms, events, and seasonal decorating moments.";
  const dimensionsLine =
    "Dimensions: Each lantern measures 10x10 inches, creating an ideal size for **hanging paper lanterns** that make a statement without overwhelming the space. The perfectly proportioned **Hanging Decor** ensures visual impact while keeping **Paper Hanging Decorations** easy to place across classrooms and parties.";

  assert.equal(packageLine.length, 319);
  assert.equal(dimensionsLine.length, 311);

  const packageResult = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [packageLine]
    })
  );
  const dimensionsResult = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [dimensionsLine]
    })
  );

  assert.equal(packageResult.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(dimensionsResult.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(packageResult.normalizedContent.length <= 300);
  assert.ok(dimensionsResult.normalizedContent.length <= 300);
  assert.match(packageResult.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(packageResult.normalizedContent, /\*\*Paper Lanterns Decorative\*\*/);
  assert.match(packageResult.normalizedContent, /\*\*Colorful Paper Lanterns\*\*/);
  assert.match(dimensionsResult.normalizedContent, /\*\*hanging paper lanterns\*\*/);
  assert.match(dimensionsResult.normalizedContent, /\*\*Hanging Decor\*\*/);
  assert.match(dimensionsResult.normalizedContent, /\*\*Paper Hanging Decorations\*\*/);
});

test("scoreRuntimeCandidateForTest compresses borderline overlong keyword-order classroom bullet lines", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Classroom Display: These lanterns pair naturally with **ceiling hanging decor**, blend smoothly into **hanging ceiling decor**, and complete **Classroom Decoration** themes for back to school rooms, reading corners, bulletin board backdrops, welcome walls, and everyday seasonal displays with easy setup.";

  assert.ok(rawLine.length > 300);

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*ceiling hanging decor\*\*/);
  assert.match(result.normalizedContent, /\*\*hanging ceiling decor\*\*/);
  assert.match(result.normalizedContent, /\*\*Classroom Decoration\*\*/);
});

test("scoreRuntimeCandidateForTest compresses first-attempt bullets patterns seen in latest runtime retries", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const packageLine =
    "Package Contents: Receive a complete set of 12 **Paper Lanterns** for immediate use in your classroom decor projects. These **Paper Lanterns Decorative** pieces are ready to hang, offering a practical solution for transformed ceilings and cheerful displays with **Colorful Paper Lanterns** for school events and parties.";
  const dimensionsLine =
    "Dimensions: Each lantern measures a perfect 10*10 inches, creating substantial visual impact as **hanging paper lanterns**. This ideal size ensures they serve as **Hanging Decor** pieces that fill classroom ceilings with presence while keeping **Paper Hanging Decorations** easy to suspend across events.";
  const usageLine =
    "Usage: Primarily designed as **chinese lanterns** that excel in classroom ceiling applications for educational environments. These **Ball Lanterns Lamps** provide excellent illumination and decorative appeal for academic celebrations while remaining suitable for **summer party decorations** and seasonal school events.";

  assert.equal(packageLine.length, 320);
  assert.equal(dimensionsLine.length, 304);
  assert.equal(usageLine.length, 319);

  for (const line of [packageLine, dimensionsLine, usageLine]) {
    const result = scoreRuntimeCandidateForTest(
      {
        brand: "gisgfim",
        category: "Paper Lanterns",
        keywords: [],
        raw: "# raw",
        values: {}
      },
      rule,
      JSON.stringify({
        bullets: [line]
      })
    );

    assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
    assert.ok(result.normalizedContent.length <= 300);
  }
});

test("scoreRuntimeCandidateForTest strips agent meta preamble from title candidates", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 10,
      max_chars: 200
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    "校验通过，现在输出最终标题：\n\ngisgfim Paper Lanterns Title"
  );

  assert.equal(result.normalizedContent, "gisgfim Paper Lanterns Title");
});

test("scoreRuntimeCandidateForTest strips title meta variants seen in real e2e output", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 10,
      max_chars: 200
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    "完美！标题已经通过了所有验证。让我输出最终的标题：\n\ngisgfim Paper Lanterns Decorative Title"
  );

  assert.equal(result.normalizedContent, "gisgfim Paper Lanterns Decorative Title");
});

test("scoreRuntimeCandidateForTest lightly compresses borderline overlong runtime title candidates", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 100,
      max_chars: 200,
      tolerance_chars: 20,
      must_contain: [
        "brand",
        "top_keywords"
      ]
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "whole"
    },
    output: {
      format: "text"
    }
  };

  const rawTitle =
    "gisgfim Paper Lanterns Paper Lanterns Decorative Colorful Paper Lanterns, 12 Pack 10x10 Inch Colorful Plaid Classroom Hanging Decor, DIY Ceiling Decorations for Wedding Baby Shower Summer Party Classroom Events and Back to School Decor";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    rawTitle
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 220);
  assert.match(result.normalizedContent, /\bPaper Lanterns\b/);
  assert.match(result.normalizedContent, /\bPaper Lanterns Decorative\b/);
  assert.match(result.normalizedContent, /\bColorful Paper Lanterns\b/);
});

test("scoreRuntimeCandidateForTest compresses runtime package bullet phrasing seen in failure logs", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 3,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Package Contents: This set includes 12 **Paper Lanterns** ready for immediate classroom decoration, offering a full **Paper Lanterns Decorative** solution that includes all necessary hanging accessories for easy setup. These **Colorful Paper Lanterns** keep displays bright for seasonal classroom use.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns Decorative\*\*/);
  assert.match(result.normalizedContent, /\*\*Colorful Paper Lanterns\*\*/);
});

test("scoreRuntimeCandidateForTest requires lowercase embedded bullet keywords when rule enables it", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 1,
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
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Package Details: This classroom set includes **Paper Lanterns** for hanging displays and keeps setup simple. It adds enough value for seasonal décor and school events without wasting useful package information.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: ["Paper Lanterns"],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.match(result.errors.join("\n"), /关键词顺序埋入不满足/);
});

test("scoreRuntimeCandidateForTest validates bullet heading word count", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 1,
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
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Usage: This classroom set uses **paper lanterns** to create a bright display for seasonal learning spaces. It keeps setup manageable while leaving enough detail for repeated events and everyday decorative use.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: ["Paper Lanterns"],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.match(result.errors.join("\n"), /小标题词数不满足约束/);
});

test("scoreRuntimeCandidateForTest can fall back to a valid bullet template above the hard minimum", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 3,
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
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Complete Set Ready: This package includes 12 ready-to-use **paper lanterns** measuring 10x10 inches each, offering immediate classroom transformation with **paper lanterns decorative** appeal. The **colorful paper lanterns** add bright seasonal energy for school displays, welcome walls, reading corners, themed parties, and everyday classroom decorating.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  const visibleLength = result.normalizedContent.replace(/\*\*/g, "").length;
  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(result.errors.filter((item) => item.includes("关键词顺序埋入不满足")).length, 0);
  assert.ok(visibleLength >= 240, `visible length too short: ${visibleLength}`);
  assert.ok(visibleLength <= 300, `visible length too long: ${visibleLength}`);
});

test("scoreRuntimeCandidateForTest rejects bullet lines below hard minimum even when tolerance exists", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 2,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 6,
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
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "ceiling hanging decor",
        "hanging ceiling decor",
        "classroom decoration",
        "chinese lanterns",
        "ball lanterns lamps",
        "summer party decorations"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [
        "Reusable Material: **ceiling hanging decor** store flat and reuse across lessons, holidays, and school events. **hanging ceiling decor** fold down after use, and **classroom decoration** help keep displays neat for the next celebration.",
        "Classroom Application: **chinese lanterns** suit classroom celebrations, bulletin boards, and themed activities. **ball lanterns lamps** add soft impact, and **summer party decorations** support school parties and quick seasonal refreshes."
      ]
    })
  );

  assert.match(result.errors.join("\n"), /第1条长度不满足约束/);
  assert.match(result.errors.join("\n"), /第2条长度不满足约束/);
});

test("scoreRuntimeCandidateForTest keeps fallback bullet lines above hard minimum for later slots", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 5,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
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

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "paper lanterns",
        "paper lanterns decorative",
        "colorful paper lanterns",
        "hanging paper lanterns",
        "hanging decor",
        "paper hanging decorations",
        "ceiling hanging decor",
        "hanging ceiling decor",
        "classroom decoration",
        "hanging classroom decoration",
        "ceiling hanging classroom decor",
        "wedding decorations",
        "chinese lanterns",
        "ball lanterns lamps",
        "summer party decorations"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [
        "Complete Set Ready: This package includes 12 ready-to-use **paper lanterns** measuring 10x10 inches each, offering immediate classroom transformation with **paper lanterns decorative** appeal. The **colorful paper lanterns** add bright seasonal energy for school displays, welcome walls, reading corners, themed parties, and everyday classroom decorating.",
        "installation Process: These **hanging paper lanterns** open quickly for ceilings and walls across busy classrooms with simple setup steps and no special tools needed at all. The **hanging decor** saves time for teachers, and **paper hanging decorations** create layered color for welcome days, reading corners, party tables, and photo backdrops across the room.",
        "Reusable Material: These **ceiling hanging decor** pieces stay easy to fold, easy to store, and easy to reuse after lessons, parties, and seasonal decorating changes throughout the year. The **hanging ceiling decor** supports repeated classroom refreshes, and **classroom decoration** keeps displays organized with practical color and visible themed structure for students.",
        "Plaid Design: The **hanging classroom decoration** adds bright plaid color for school spaces while keeping displays tidy, visible, and cheerful during welcome weeks, class parties, and craft activities. The **ceiling hanging classroom decor** helps anchor focal points, and **wedding decorations** styling keeps tables, doors, and corners looking neat from every angle.",
        "Classroom Application: These **chinese lanterns** work across classroom celebrations, bulletin boards, reading corners, and themed activity tables while still staying light, easy to move, and easy to hang for teachers. The **ball lanterns lamps** add soft visual impact, and **summer party decorations** support seasonal refreshes, school events, and reusable party setups across indoor spaces."
      ]
    })
  );

  const lines = result.normalizedContent.split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines[2]!.length >= 240, `line 3 too short: ${lines[2]!.length}`);
  assert.ok(lines[4]!.length >= 240, `line 5 too short: ${lines[4]!.length}`);
});

test("buildTranslationReusePlanForTest reuses unchanged runtime translations and only marks repaired sections for re-translation", () => {
  const result = buildTranslationReusePlanForTest(
    {
      title: "title-en-v1",
      bullets: "bullets-en-v1",
      description: "description-en-v1"
    },
    {
      title: "title-en-v1",
      bullets: "bullets-en-v2",
      description: "description-en-v1"
    },
    {
      category_cn: "分类-cn",
      keywords_cn: "关键词-cn",
      title_cn: "标题-cn-v1",
      bullets_cn: "五点-cn-v1",
      description_cn: "描述-cn-v1"
    }
  );

  assert.deepEqual(result.reusedTranslations, {
    category_cn: "分类-cn",
    keywords_cn: "关键词-cn",
    title_cn: "标题-cn-v1",
    description_cn: "描述-cn-v1"
  });
  assert.deepEqual(result.pendingSectionKeys, ["bullets"]);
});

test("resolveRuntimeTeamAttemptsForTest defaults runtime agent team retries to one whole-run attempt", () => {
  assert.equal(resolveRuntimeTeamAttemptsForTest({}), 1);
  assert.equal(resolveRuntimeTeamAttemptsForTest({ api_attempts: 0 }), 1);
  assert.equal(resolveRuntimeTeamAttemptsForTest({ api_attempts: 1 }), 1);
  assert.equal(resolveRuntimeTeamAttemptsForTest({ api_attempts: 3 }), 3);
});

test("resolveRuntimeTeamMaxTurnsForTest keeps bullets high while giving description extra repair budget", () => {
  assert.equal(resolveRuntimeTeamMaxTurnsForTest("bullets", true), 12);
  assert.equal(resolveRuntimeTeamMaxTurnsForTest("title", true), 8);
  assert.equal(resolveRuntimeTeamMaxTurnsForTest("description", false), 8);
});

test("compactSectionRequirementsRawForPromptForTest removes duplicated keyword and category blocks for description", () => {
  const raw = [
    "# 基础信息",
    "",
    "品牌名: gisgfim",
    "颜色: Colorful plaid",
    "",
    "# 关键词库",
    "",
    "Paper Lanterns",
    "",
    "Classroom Decoration",
    "",
    "# 分类",
    "",
    "Paper Lanterns",
    "",
    "# 特殊关键要求",
    "",
    "适用场景最主要是教室悬挂装饰"
  ].join("\n");

  const result = compactSectionRequirementsRawForPromptForTest(raw, "description");

  assert.match(result, /品牌名: gisgfim/);
  assert.match(result, /适用场景最主要是教室悬挂装饰/);
  assert.doesNotMatch(result, /Paper Lanterns\n\nClassroom Decoration/);
  assert.doesNotMatch(result, /# 分类/);
});

test("shouldRunPromptPlanningForTest disables legacy planner brief in runtime-native execution", () => {
  assert.equal(
    shouldRunPromptPlanningForTest({
      generationConfig: {
        planning: {
          enabled: true,
          retries: 1,
          system_prompt: "plan",
          user_prompt: "plan"
        }
      }
    } as any),
    false
  );
  assert.equal(
    shouldRunPromptPlanningForTest({
      generationConfig: {
        planning: {
          enabled: false,
          retries: 1,
          system_prompt: "plan",
          user_prompt: "plan"
        }
      }
    } as any),
    false
  );
});
