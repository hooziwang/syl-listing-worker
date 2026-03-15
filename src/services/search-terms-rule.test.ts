import test from "node:test";
import assert from "node:assert/strict";
import type { ListingRequirements } from "./requirements-parser.js";
import { buildSearchTermsFromRule } from "./generation-service.js";
import type { SectionRule } from "./rules-loader.js";

test("buildSearchTermsFromRule lowercases search terms when rule requires lowercase", () => {
  const requirements: ListingRequirements = {
    raw: "",
    brand: "Brand",
    category: "Category",
    keywords: ["Paper Lanterns", "Classroom Decor", "Party Supplies"],
    values: {}
  };

  const rule: SectionRule = {
    section: "search_terms",
    language: "en",
    instruction: "输出英文搜索词，全部小写。",
    constraints: {
      source: "keywords_copy",
      separator: " ",
      dedupe: true,
      lowercase: true
    },
    execution: {
      retries: 2,
      generation_mode: "whole"
    },
    output: {
      format: "text"
    }
  };

  assert.equal(
    buildSearchTermsFromRule(requirements, rule),
    "paper lanterns classroom decor party supplies"
  );
});

test("buildSearchTermsFromRule allows search terms at exactly 255 chars", () => {
  const requirements: ListingRequirements = {
    raw: "",
    brand: "Brand",
    category: "Category",
    keywords: ["a".repeat(128), "b".repeat(126)],
    values: {}
  };

  const rule: SectionRule = {
    section: "search_terms",
    language: "en",
    instruction: "输出英文搜索词，空格分隔，不加标点，不重复，总长度不得超过 255 字符。",
    constraints: {
      source: "keywords_copy",
      separator: " ",
      dedupe: true,
      min_chars: 120,
      max_chars: 255,
      tolerance_chars: 0
    },
    execution: {
      retries: 2,
      generation_mode: "whole"
    },
    output: {
      format: "text"
    }
  };

  const result = buildSearchTermsFromRule(requirements, rule);
  assert.equal(result.length, 255);
});

test("buildSearchTermsFromRule compacts overlong search terms to stay within 255 chars", () => {
  const requirements: ListingRequirements = {
    raw: "",
    brand: "Brand",
    category: "Category",
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
      "wedding decorations"
    ],
    values: {}
  };

  const rule: SectionRule = {
    section: "search_terms",
    language: "en",
    instruction: "输出英文搜索词，空格分隔，不加标点，不重复，总长度不得超过 255 字符。",
    constraints: {
      source: "keywords_copy",
      separator: " ",
      dedupe: true,
      min_chars: 120,
      max_chars: 255,
      tolerance_chars: 0
    },
    execution: {
      retries: 2,
      generation_mode: "whole"
    },
    output: {
      format: "text"
    }
  };

  const result = buildSearchTermsFromRule(requirements, rule);
  assert.ok(result.length <= 255, `expected <=255 chars, got ${result.length}`);
  assert.equal(
    result,
    "Paper Lanterns Paper Lanterns Decorative Colorful Paper Lanterns hanging paper lanterns Hanging Decor Paper Hanging Decorations ceiling hanging decor hanging ceiling decor Classroom Decoration Hanging Classroom Decoration ceiling hanging Classroom decor"
  );
});

test("buildSearchTermsFromRule still throws when a single term exceeds the hard max", () => {
  const requirements: ListingRequirements = {
    raw: "",
    brand: "Brand",
    category: "Category",
    keywords: ["a".repeat(256)],
    values: {}
  };

  const rule: SectionRule = {
    section: "search_terms",
    language: "en",
    instruction: "输出英文搜索词，空格分隔，不加标点，不重复，总长度不得超过 255 字符。",
    constraints: {
      source: "keywords_copy",
      separator: " ",
      dedupe: true,
      min_chars: 120,
      max_chars: 255,
      tolerance_chars: 0
    },
    execution: {
      retries: 2,
      generation_mode: "whole"
    },
    output: {
      format: "text"
    }
  };

  assert.throws(
    () => buildSearchTermsFromRule(requirements, rule),
    /长度不满足约束: 256（规则区间 \[120,255\]，容差区间 \[120,255\]）/
  );
});
