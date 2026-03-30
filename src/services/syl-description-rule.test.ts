import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse as parseYAML } from "yaml";

test("syl description rule requires the first 8 keywords to appear in order", async () => {
  const raw = await readFile(
    new URL("../../../rules/tenants/syl/rules/sections/description.yaml", import.meta.url),
    "utf8"
  );
  const parsed = parseYAML(raw) as {
    instruction?: string;
    constraints?: {
      keyword_embedding?: {
        min_total?: number;
        enforce_order?: boolean;
      };
    };
  };
  const instruction = parsed.instruction ?? "";

  assert.match(instruction, /前 8 个关键词必须按关键词库顺序原样出现/);
  assert.match(instruction, /每个关键词必须使用 Markdown 粗体包裹/);
  assert.match(instruction, /前 8 个关键词按关键词库顺序的埋入情况满足上述“关键词埋入要求（全局）”/);
  assert.equal(parsed.constraints?.keyword_embedding?.min_total, 8);
  assert.equal(parsed.constraints?.keyword_embedding?.enforce_order, true);
});
