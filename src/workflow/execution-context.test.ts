import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionContext } from "./execution-context.js";

test("ExecutionContext stores and reads slot values", () => {
  const ctx = new ExecutionContext({
    category: "Paper Lanterns"
  });

  ctx.set("title_en", "Decorative Paper Lanterns");

  assert.equal(ctx.get("category"), "Paper Lanterns");
  assert.equal(ctx.get("title_en"), "Decorative Paper Lanterns");
});

test("ExecutionContext throws on missing slot", () => {
  const ctx = new ExecutionContext();

  assert.throws(() => ctx.get("missing_slot"), /slot not found: missing_slot/);
});

test("ExecutionContext picks multiple inputs by slot name", () => {
  const ctx = new ExecutionContext({
    title_en: "Title",
    bullets_en: "Bullets"
  });

  assert.deepEqual(ctx.pick(["title_en", "bullets_en"]), {
    title_en: "Title",
    bullets_en: "Bullets"
  });
});
