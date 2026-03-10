import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionContext } from "../execution-context.js";
import { DeriveNodeExecutor } from "./derive-node.js";
import { RenderNodeExecutor } from "./render-node.js";

test("DeriveNodeExecutor builds search terms from keywords slot", async () => {
  const executor = new DeriveNodeExecutor();
  const ctx = new ExecutionContext({
    keywords: "paper lanterns\nclassroom decor\nparty supplies"
  });

  const result = await executor.execute(
    {
      id: "search_terms_en",
      type: "derive",
      section: "search_terms",
      output_to: "search_terms_en"
    },
    ctx
  );

  assert.equal(result.outputSlot, "search_terms_en");
  assert.equal(result.outputValue, "paper lanterns classroom decor party supplies");
});

test("RenderNodeExecutor renders template from slots", async () => {
  const executor = new RenderNodeExecutor({
    en: "# EN\n{{title_en}}\n",
    cn: "# CN\n{{title_cn}}\n"
  });
  const ctx = new ExecutionContext({
    title_cn: "中文标题"
  });

  const result = await executor.execute(
    {
      id: "render_cn",
      type: "render",
      template: "cn",
      output_to: "cn_markdown"
    },
    ctx
  );

  assert.equal(result.outputSlot, "cn_markdown");
  assert.equal(result.outputValue, "# CN\n中文标题");
});
