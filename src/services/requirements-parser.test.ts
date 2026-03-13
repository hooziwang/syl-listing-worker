import test from "node:test";
import assert from "node:assert/strict";
import { inputMatchesMarker, parseRequirements } from "./requirements-parser.js";
import type { InputRules } from "./rules-loader.js";

const inputRules: InputRules = {
  file_discovery: {
    marker: "===Listing Requirements==="
  },
  fields: [
    {
      key: "brand",
      type: "scalar",
      capture: "inline_label",
      labels: ["品牌名", "品牌", "brand"],
      fallback: "UnknownBrand",
      fallback_from_h1_first_token: true
    },
    {
      key: "keywords",
      type: "list",
      capture: "heading_section",
      heading_aliases: ["关键词", "keyword"],
      min_count: 15,
      unique_required: true
    },
    {
      key: "category",
      type: "scalar",
      capture: "heading_section",
      heading_aliases: ["分类", "category"]
    }
  ]
};

test("parseRequirements reads fields from generic input contract", () => {
  const inputMarkdown = `# Demo Product

品牌名: Gisgfim

## 分类
- Paper Lanterns

## 关键词
- paper lanterns
- classroom decor
- party supplies
`;

  const requirements = parseRequirements(inputMarkdown, inputRules);

  assert.equal(requirements.brand, "Gisgfim");
  assert.equal(requirements.category, "Paper Lanterns");
  assert.deepEqual(requirements.keywords, ["paper lanterns", "classroom decor", "party supplies"]);
  assert.equal(requirements.values.brand, "Gisgfim");
});

test("parseRequirements falls back to h1 first token for brand", () => {
  const inputMarkdown = `# Gisgfim Lantern Set

## 分类
Paper Lanterns

## 关键词
- paper lanterns
- classroom decor
`;

  const requirements = parseRequirements(inputMarkdown, inputRules);

  assert.equal(requirements.brand, "Gisgfim");
});

test("inputMatchesMarker requires the configured discovery marker", () => {
  assert.equal(inputMatchesMarker(`===Listing Requirements===\n\n# Demo`, inputRules), true);
  assert.equal(inputMatchesMarker(`\ufeff===Listing Requirements===\n\n# Demo`, inputRules), true);
  assert.equal(inputMatchesMarker(`# Demo\n\n品牌名: Gisgfim`, inputRules), false);
});
