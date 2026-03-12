import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionContext } from "./execution-context.js";
import { buildRenderVariables, collectNodeSectionSlots, parseJudgeIssues } from "./bindings.js";
import type { InputFieldRule, SectionRule } from "../services/rules-loader.js";
import type { GenerationNode } from "./types.js";

function makeSectionRule(
  section: string,
  constraints: Record<string, unknown> = {}
): SectionRule {
  return {
    section,
    language: "en",
    instruction: "ok",
    constraints,
    execution: {
      retries: 2,
      generation_mode: "whole"
    },
    output: {
      format: "text"
    }
  };
}

test("collectNodeSectionSlots prefers node.inputs bindings", () => {
  const ctx = new ExecutionContext({
    title_en: "Title A",
    bullets_en: "Line 1\nLine 2"
  });
  const node: GenerationNode = {
    id: "review_round_1",
    type: "judge",
    output_to: "judge_report_round_1",
    inputs: {
      title: "title_en",
      bullets: "bullets_en"
    }
  };

  const slots = collectNodeSectionSlots(node, ctx);

  assert.deepEqual(slots, {
    title: "Title A",
    bullets: "Line 1\nLine 2"
  });
});

test("buildRenderVariables formats list fields and line-based sections from bindings", () => {
  const ctx = new ExecutionContext({
    brand: "gisgfim",
    keywords: "paper lanterns\nclassroom decor",
    bullets_en: "用途广泛：A。\n材质耐用：B。",
    title_en: "Paper Lanterns"
  });
  const node: GenerationNode = {
    id: "render_en",
    type: "render",
    template: "en",
    output_to: "en_markdown",
    inputs: {
      brand: "brand",
      keywords_en: "keywords",
      bullets_en: "bullets_en",
      title_en: "title_en"
    }
  };
  const inputFields: InputFieldRule[] = [
    {
      key: "brand",
      type: "scalar",
      capture: "inline_label",
      required: true
    },
    {
      key: "keywords",
      type: "list",
      capture: "heading_section",
      required: true
    }
  ];
  const sections = new Map<string, SectionRule>([
    ["bullets", makeSectionRule("bullets", { line_count: 2 })]
  ]);

  const vars = buildRenderVariables(node, ctx, {
    inputFields,
    sections,
    render: {
      keywords_item_template: "- {{item}}",
      bullets_item_template: "**{{item}}**",
      bullets_separator: "\n\n"
    }
  });

  assert.equal(vars.brand, "gisgfim");
  assert.equal(vars.keywords_en, "- paper lanterns\n- classroom decor");
  assert.equal(vars.bullets_en, "**用途广泛：A。**\n\n**材质耐用：B。**");
  assert.equal(vars.title_en, "Paper Lanterns");
});

test("parseJudgeIssues only accepts sections declared by node inputs", () => {
  const issues = parseJudgeIssues(
    `- [title] 缺少关键词\n- [description] 过长\n- [unknown] 忽略`,
    ["无问题"],
    ["title", "description"]
  );

  assert.deepEqual(issues, [
    { section: "title", message: "缺少关键词" },
    { section: "description", message: "过长" }
  ]);
});
