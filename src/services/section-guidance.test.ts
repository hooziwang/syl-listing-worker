import assert from "node:assert/strict";
import test from "node:test";
import type { ListingRequirements } from "./requirements-parser.js";
import type { SectionRule } from "./rules-loader.js";
import {
  buildSectionExecutionGuidance,
  buildSectionRepairGuidance,
  buildSectionKeywordPlan
} from "./section-guidance.js";

function makeBulletsRule(): SectionRule {
  return {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 5,
      min_chars_per_line: 240,
      hard_min_chars_per_line: true,
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

function makeRequirements(): ListingRequirements {
  return {
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
      "summer party decorations",
      "hanging decor from ceiling"
    ],
    raw: "# raw",
    values: {}
  };
}

function makeDescriptionHeavyRequirements(): ListingRequirements {
  return {
    brand: "gisgfim",
    category: "Paper Lanterns",
    keywords: [
      "lanterns",
      "party decor",
      "class decor",
      "ceiling decor",
      "paper decor",
      "event decor",
      "home decor",
      "holiday decor",
      "classroom decoration ideas for hanging ceiling displays",
      "back to school lantern decoration kit for classroom events",
      "wedding reception hanging lantern decor set for ceilings",
      "festival paper lantern bundle with layered hanging accents",
      "large chinese lantern party supplies for indoor celebrations",
      "round lantern lamp shades for seasonal classroom makeovers",
      "summer party ceiling decoration pack with reusable lanterns",
      "hanging decor from ceiling for themed school celebrations"
    ],
    raw: "# raw",
    values: {}
  };
}

function makeDescriptionRule(): SectionRule {
  return {
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
      keyword_embedding: {
        enabled: true,
        min_total: 6,
        enforce_order: false,
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
}

function makeTitleRule(): SectionRule {
  return {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 100,
      max_chars: 200,
      tolerance_chars: 20,
      must_contain: ["brand", "top_keywords"]
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
}

test("buildSectionKeywordPlan batches ordered keywords across bullet lines", () => {
  const plan = buildSectionKeywordPlan(makeRequirements(), makeBulletsRule());

  assert.equal(plan.length, 5);
  assert.deepEqual(plan[0], [
    "paper lanterns",
    "paper lanterns decorative",
    "colorful paper lanterns"
  ]);
  assert.deepEqual(plan[4], [
    "chinese lanterns",
    "ball lanterns lamps",
    "summer party decorations"
  ]);
});

test("buildSectionExecutionGuidance emits generic rule-driven bullet guidance", () => {
  const guidance = buildSectionExecutionGuidance(makeRequirements(), makeBulletsRule());

  assert.match(guidance, /第1条.*\*\*paper lanterns\*\* -> \*\*paper lanterns decorative\*\* -> \*\*colorful paper lanterns\*\*/);
  assert.match(guidance, /固定输出 5 条/);
  assert.match(guidance, /每条小标题词数控制在 2-4 个英文单词/);
  assert.match(guidance, /每条长度控制在 240-300 字符/);
  assert.match(guidance, /前 15 个关键词必须按关键词库顺序出现/);
  assert.match(guidance, /关键词出现时必须保持小写/);
  assert.match(guidance, /关键词必须使用 Markdown 粗体包裹/);
  assert.match(guidance, /连续的 2 个星号 \*\* 不计入字符数/);
  assert.match(guidance, /按以下条级关键词批次依次消化，不要打乱顺序/);
  assert.match(guidance, /第1条建议长度 255-265 字符/);
  assert.match(guidance, /第4条建议长度 \d+-\d+ 字符；本条关键词较长，正文更紧凑/);
  assert.doesNotMatch(guidance, /第2、3、4条不要套固定模版/);
  assert.doesNotMatch(guidance, /套装内容|拿来即用|尺寸|材质|颜色/);
  assert.doesNotMatch(guidance, /ideal|perfect|transform|create|bring|enhance/);
});

test("buildSectionRepairGuidance maps bullet failures back to generic rule-driven repair steps", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeBulletsRule(),
    [
      "第1条长度不满足约束: 331（规则区间 [200,270]，容差区间 [170,300]）",
      "关键词顺序埋入不满足: 第6个关键词未按顺序原样出现: Paper Hanging Decorations"
    ]
  );

  assert.match(guidance, /第1条修复到 255-265 字符/);
  assert.match(guidance, /第1条当前超出上限 31 字符，请压缩到目标区间/);
  assert.match(guidance, /每条小标题词数控制在 2-4 个英文单词/);
  assert.match(guidance, /关键词出现时必须保持小写/);
  assert.match(guidance, /关键词必须使用 Markdown 粗体包裹/);
  assert.match(guidance, /连续的 2 个星号 \*\* 不计入字符数/);
  assert.match(guidance, /从第2条开始按既定关键词顺序修复/);
  assert.match(guidance, /第2条关键词批次: \*\*hanging paper lanterns\*\* -> \*\*hanging decor\*\* -> \*\*paper hanging decorations\*\*/);
  assert.doesNotMatch(guidance, /尺寸|材质|颜色/);
  assert.doesNotMatch(guidance, /安全目标/);
});

test("buildSectionRepairGuidance keeps bullet repair guidance generic even for heavier keyword batches", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeBulletsRule(),
    [
      "第4条长度不满足约束: 309（规则区间 [200,270]，容差区间 [170,300]）"
    ]
  );

  assert.match(guidance, /第4条修复到 255-265 字符/);
  assert.match(guidance, /第4条优先收敛到建议长度 255-265 字符/);
  assert.match(guidance, /第4条当前超出上限 9 字符，请压缩到目标区间/);
  assert.doesNotMatch(guidance, /本条关键词较长/);
  assert.doesNotMatch(guidance, /that\/which\/while\/allowing\/providing\/making\/ensuring/);
  assert.doesNotMatch(guidance, /ideal|perfect|transform|create|bring|enhance/);
});

test("buildSectionRepairGuidance tells underlength bullets to fill the rule-driven target range", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeBulletsRule(),
    [
      "第2条长度不满足约束: 228（规则区间 [240,250]，容差区间 [240,300]）"
    ]
  );

  assert.match(guidance, /第2条修复到 255-265 字符/);
  assert.match(guidance, /第2条当前低于下限 12 字符，请补足到目标区间/);
  assert.doesNotMatch(guidance, /具体产品细节或结果句/);
  assert.doesNotMatch(guidance, /不要停在 230-239/);
  assert.doesNotMatch(guidance, /优先删除重复修饰和泛化铺陈/);
});

test("buildSectionExecutionGuidance includes generic paragraph guidance for description", () => {
  const guidance = buildSectionExecutionGuidance(makeRequirements(), makeDescriptionRule());

  assert.match(guidance, /固定输出 2 段/);
  assert.match(guidance, /当前 execution 配置总句数 5，请按 2 个输出槽位均匀分配/);
  assert.match(guidance, /整体长度控制在 700-740 字符/);
  assert.match(guidance, /每段必须以完整句和句末标点收尾/);
  assert.match(guidance, /第1段建议长度 350-370 字符/);
  assert.match(guidance, /第2段建议长度 350-370 字符/);
  assert.doesNotMatch(guidance, /全文自然覆盖前 \d+ 个关键词/);
  assert.doesNotMatch(guidance, /前 \d+ 个必带关键词/);
  assert.doesNotMatch(guidance, /前 \d+ 个关键词满足后就停止追加更多关键词/);
  assert.doesNotMatch(guidance, /第1段关键词批次/);
  assert.doesNotMatch(guidance, /第2段关键词批次/);
  assert.doesNotMatch(guidance, /默认先写 4 句|最重要的 4-6 个事实或收益/);
});

test("buildSectionExecutionGuidance keeps description paragraph budgets without paragraph keyword batches", () => {
  const guidance = buildSectionExecutionGuidance(makeDescriptionHeavyRequirements(), makeDescriptionRule());

  assert.match(guidance, /第1段建议长度 350-370 字符/);
  assert.match(guidance, /第2段建议长度 350-370 字符/);
  assert.doesNotMatch(guidance, /本段关键词较短/);
  assert.doesNotMatch(guidance, /本段关键词较长/);
});

test("buildSectionRepairGuidance keeps description fixes global when keyword position is unrestricted", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeDescriptionRule(),
    [
      "长度不满足约束: 764（规则区间 [700,740]，容差区间 [700,740]）",
      "段落数量不满足约束: 3（规则区间 [2,2]）",
      "第1段结尾不是完整句子（缺少句末标点）",
      "缺少关键词 #6: Paper Hanging Decorations"
    ]
  );

  assert.match(guidance, /固定输出 2 段/);
  assert.match(guidance, /当前超出上限 24 字符/);
  assert.match(guidance, /第2段优先收敛到建议长度 350-370 字符/);
  assert.match(guidance, /第1段必须以完整句和句末标点收尾/);
  assert.match(guidance, /必须补回缺失关键词：Paper Hanging Decorations/);
  assert.doesNotMatch(guidance, /前 \d+ 个关键词/);
  assert.doesNotMatch(guidance, /按既定关键词批次重写/);
  assert.doesNotMatch(guidance, /关键词批次/);
});

test("buildSectionRepairGuidance keeps title repair guidance generic and rule-driven", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeTitleRule(),
    [
      "长度不满足约束: 226（规则区间 [100,200]，容差区间 [80,220]）",
      "缺少品牌词: gisgfim",
      "缺少关键词 #2: Paper Lanterns Decorative"
    ]
  );

  assert.match(guidance, /输出单行标题文本/);
  assert.match(guidance, /当前超出上限 6 字符/);
  assert.match(guidance, /整体长度控制在 100-220 字符/);
  assert.match(guidance, /必须补回缺失品牌词：gisgfim/);
  assert.match(guidance, /必须补回缺失关键词：Paper Lanterns Decorative/);
  assert.doesNotMatch(guidance, /前序条目/);
  assert.doesNotMatch(guidance, /第1条重写到/);
});

test("buildSectionRepairGuidance keeps heavy description rewrites generic when keyword positions are unrestricted", () => {
  const guidance = buildSectionRepairGuidance(
    makeDescriptionHeavyRequirements(),
    makeDescriptionRule(),
    [
      "长度不满足约束: 758（规则区间 [700,740]，容差区间 [700,740]）"
    ]
  );

  assert.match(guidance, /当前超出上限 18 字符/);
  assert.match(guidance, /第2段优先收敛到建议长度 350-370 字符/);
  assert.doesNotMatch(guidance, /本段关键词较长/);
});
