import test from "node:test";
import assert from "node:assert/strict";
import { ExecutorRegistry } from "./registry.js";
import { ExecutionContext } from "./execution-context.js";
import type { NodeExecutionResult, NodeExecutor } from "./node-executor.js";
import type { WorkflowNode } from "./types.js";

class StubExecutor implements NodeExecutor {
  constructor(
    private readonly nodeType: WorkflowNode["type"],
    private readonly outputValue: string
  ) {}

  supports(node: WorkflowNode): boolean {
    return node.type === this.nodeType;
  }

  async execute(node: WorkflowNode): Promise<NodeExecutionResult> {
    return {
      outputSlot: node.output_to,
      outputValue: this.outputValue
    };
  }
}

test("ExecutorRegistry dispatches to matching executor", async () => {
  const registry = new ExecutorRegistry([
    new StubExecutor("translate", "translated"),
    new StubExecutor("render", "rendered")
  ]);
  const ctx = new ExecutionContext({
    title_en: "title"
  });

  const result = await registry.execute(
    {
      id: "title_cn",
      type: "translate",
      input_from: "title_en",
      output_to: "title_cn"
    },
    ctx
  );

  assert.equal(result.outputValue, "translated");
});

test("ExecutorRegistry rejects unsupported node", async () => {
  const registry = new ExecutorRegistry([]);
  const ctx = new ExecutionContext();

  await assert.rejects(
    () =>
      registry.execute(
        {
          id: "title_en",
          type: "generate",
          section: "title",
          output_to: "title_en"
        },
        ctx
      ),
    /no executor for workflow node: generate/
  );
});
