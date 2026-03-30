import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse as parseYAML } from "yaml";

test("syl description rule requires natural coverage of the first 8 keywords", async () => {
  const raw = await readFile(
    new URL("../../../rules/tenants/syl/rules/sections/description.yaml", import.meta.url),
    "utf8"
  );
  const parsed = parseYAML(raw) as {
    instruction?: string;
    constraints?: {
      keyword_embedding?: {
        min_total?: number;
      };
    };
  };
  const instruction = parsed.instruction ?? "";

  assert.match(instruction, /全文至少自然埋入前 8 个关键词，不限制关键词落在哪一段/);
  assert.match(instruction, /前 8 个关键词埋入情况满足上述“关键词埋入要求（全局）”/);
  assert.equal(parsed.constraints?.keyword_embedding?.min_total, 8);
});
