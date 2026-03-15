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

test("buildSectionExecutionGuidance includes per-line keyword batches and char budgets", () => {
  const guidance = buildSectionExecutionGuidance(makeRequirements(), makeBulletsRule());

  assert.match(guidance, /第1条.*\*\*paper lanterns\*\* -> \*\*paper lanterns decorative\*\* -> \*\*colorful paper lanterns\*\*/);
  assert.match(guidance, /每条最佳落点 255-265 字符，略高于 250 字符更稳妥/);
  assert.match(guidance, /绝对上限 300 字符/);
  assert.match(guidance, /先写 2-4 个英文单词的小标题/);
  assert.match(guidance, /每条首个关键词必须在小标题后尽快出现/);
  assert.match(guidance, /关键词一律使用小写并加粗/);
  assert.match(guidance, /第2、3、4条不要套固定模版，优先发掘产品最强优点/);
  assert.match(guidance, /字符数按最终文本逐字符计算，空格和标点都计入长度/);
  assert.match(guidance, /连续的 2 个星号 \*\* 不计入字符数/);
  assert.match(guidance, /第1条围绕套装内容、数量和拿来即用，自拟 2-4 个单词小标题/);
  assert.match(guidance, /第4条不要固定写颜色，自拟 2-4 个单词小标题/);
  assert.match(guidance, /第二句只补 1 个结果或用途，不要继续枚举多个场景、并列多个空泛卖点/);
  assert.match(guidance, /禁止 that\/which\/while\/allowing\/providing\/making\/ensuring 这类拖尾扩写/);
  assert.match(guidance, /禁止 ideal、perfect、transform、create、bring、enhance 这类空泛词/);
  assert.match(guidance, /第4条建议长度 \d+-\d+ 字符；本条关键词较长，正文更紧凑/);
  assert.doesNotMatch(guidance, /安全目标长度/);
  assert.doesNotMatch(guidance, /正文只写 2 句短句/);
});

test("buildSectionRepairGuidance maps length and keyword-order failures back to bullet lines", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeBulletsRule(),
    [
      "第1条长度不满足约束: 331（规则区间 [200,270]，容差区间 [170,300]）",
      "关键词顺序埋入不满足: 第6个关键词未按顺序原样出现: Paper Hanging Decorations"
    ]
  );

  assert.match(guidance, /第1条重写到 252-258 字符/);
  assert.match(guidance, /第1条当前超出上限 31 字符/);
  assert.match(guidance, /每条小标题控制在 2-4 个英文单词，关键词一律使用小写加粗/);
  assert.match(guidance, /连续的 2 个星号 \*\* 不计入字符数/);
  assert.match(guidance, /从第2条开始按既定关键词批次重写/);
  assert.match(guidance, /第2条中关键词必须按批次顺序首次出现，先写第1个，再写第2个，最后写第3个关键词/);
  assert.match(guidance, /第2条不要固定写尺寸，自拟 2-4 个单词小标题/);
  assert.match(guidance, /第2条关键词批次: \*\*hanging paper lanterns\*\* -> \*\*hanging decor\*\* -> \*\*paper hanging decorations\*\*/);
  assert.doesNotMatch(guidance, /安全目标/);
});

test("buildSectionRepairGuidance highlights tighter target for longer keyword batches", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeBulletsRule(),
    [
      "第4条长度不满足约束: 309（规则区间 [200,270]，容差区间 [170,300]）"
    ]
  );

  assert.match(guidance, /第4条重写到 252-258 字符/);
  assert.match(guidance, /第4条不要固定写颜色，自拟 2-4 个单词小标题/);
  assert.match(guidance, /第4条优先收敛到建议长度 \d+-\d+ 字符；本条关键词较长，正文更紧凑/);
  assert.match(guidance, /删掉 that\/which\/while\/allowing\/providing\/making\/ensuring 这类拖尾扩写/);
  assert.match(guidance, /不要再补 ideal、perfect、transform、create、bring、enhance 这类空泛词/);
});

test("buildSectionRepairGuidance tells underlength bullets to add concrete detail instead of trimming", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeBulletsRule(),
    [
      "第2条长度不满足约束: 228（规则区间 [240,250]，容差区间 [240,300]）"
    ]
  );

  assert.match(guidance, /第2条当前低于下限 12 字符，优先补 1 个具体产品细节或结果句/);
  assert.match(guidance, /不要只改几个词，至少补足缺少的长度/);
  assert.match(guidance, /补完后最好落到 252-258 字符/);
  assert.match(guidance, /不要停在 230-239 这类仍会失败的长度，至少补到 252 字符以上再停/);
  assert.doesNotMatch(guidance, /第2条当前低于下限 12 字符，优先删除重复修饰和泛化铺陈/);
});

test("buildSectionExecutionGuidance includes paragraph guidance for description", () => {
  const guidance = buildSectionExecutionGuidance(makeRequirements(), makeDescriptionRule());

  assert.match(guidance, /固定输出 2 段/);
  assert.match(guidance, /整体目标长度 700-740 字符/);
  assert.match(guidance, /每段建议控制在 350-370 字符/);
  assert.match(guidance, /第1段关键词批次: \*\*Paper Lanterns\*\*/);
  assert.match(guidance, /第2段关键词批次: \*\*Classroom Decoration\*\*/);
});

test("buildSectionExecutionGuidance includes per-paragraph budgets for heavier description keyword batches", () => {
  const guidance = buildSectionExecutionGuidance(makeDescriptionHeavyRequirements(), makeDescriptionRule());

  assert.match(guidance, /第1段建议长度 \d+-\d+ 字符；本段关键词较短，可补足细节/);
  assert.match(guidance, /第2段建议长度 \d+-\d+ 字符；本段关键词较长，正文更紧凑/);
});

test("buildSectionRepairGuidance maps paragraph and keyword-order failures back to description paragraphs", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeDescriptionRule(),
    [
      "长度不满足约束: 764（规则区间 [700,740]，容差区间 [700,740]）",
      "段落数量不满足约束: 3（规则区间 [2,2]）",
      "第1段结尾不是完整句子（缺少句末标点）",
      "关键词顺序埋入不满足: 第9个关键词未按顺序原样出现: Classroom Decoration"
    ]
  );

  assert.match(guidance, /固定输出 2 段/);
  assert.match(guidance, /当前超出上限 24 字符/);
  assert.match(guidance, /第2段优先收敛到建议长度 \d+-\d+ 字符/);
  assert.match(guidance, /第1段必须以完整句和句末标点收尾/);
  assert.match(guidance, /从第2段开始按既定关键词批次重写/);
  assert.match(guidance, /第2段关键词批次: \*\*Classroom Decoration\*\* -> \*\*Hanging Classroom Decoration\*\*/);
});

test("buildSectionRepairGuidance gives title-specific guidance instead of bullet instructions", () => {
  const guidance = buildSectionRepairGuidance(
    makeRequirements(),
    makeTitleRule(),
    [
      "长度不满足约束: 226（规则区间 [100,200]，容差区间 [80,220]）",
      "缺少品牌词: gisgfim",
      "缺少关键词 #2: Paper Lanterns Decorative"
    ]
  );

  assert.match(guidance, /标题必须保持单行/);
  assert.match(guidance, /当前超出上限 6 字符/);
  assert.match(guidance, /总长度控制在 100-200 字符，绝不超过 220 字符/);
  assert.match(guidance, /必须补回品牌词 gisgfim/);
  assert.match(guidance, /必须补回前 3 条核心关键词中缺失的短语/);
  assert.doesNotMatch(guidance, /前序条目/);
  assert.doesNotMatch(guidance, /第1条重写到/);
});

test("buildSectionRepairGuidance highlights tighter paragraph target for heavier description keyword batches", () => {
  const guidance = buildSectionRepairGuidance(
    makeDescriptionHeavyRequirements(),
    makeDescriptionRule(),
    [
      "长度不满足约束: 758（规则区间 [700,740]，容差区间 [700,740]）"
    ]
  );

  assert.match(guidance, /当前超出上限 18 字符/);
  assert.match(guidance, /第2段优先收敛到建议长度 \d+-\d+ 字符；本段关键词较长，正文更紧凑/);
});
