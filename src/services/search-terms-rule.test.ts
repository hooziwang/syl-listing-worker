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
