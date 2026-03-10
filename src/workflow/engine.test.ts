import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowGraph } from "./graph.js";
import { ExecutionContext } from "./execution-context.js";
import { WorkflowEngine, type NodeExecutorRegistry } from "./engine.js";
import type { NodeExecutionResult } from "./node-executor.js";
import type { WorkflowNode, WorkflowSpec } from "./types.js";

class FakeRegistry implements NodeExecutorRegistry {
  public readonly calls: string[] = [];

  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult> {
    this.calls.push(node.id);
    const suffix = node.input_from ? `:${ctx.get(node.input_from)}` : "";
    if (node.id === "title_cn") {
      return {
        outputSlot: node.output_to,
        outputValue: `${node.id}${suffix}`,
        writes: {
          title_preview: "preview-ready"
        }
      };
    }
    return {
      outputSlot: node.output_to,
      outputValue: `${node.id}${suffix}`
    };
  }
}

class ParallelRegistry implements NodeExecutorRegistry {
  public active = 0;
  public maxActive = 0;

  async execute(node: WorkflowNode): Promise<NodeExecutionResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.active -= 1;
    return {
      outputSlot: node.output_to,
      outputValue: node.id
    };
  }
}

test("WorkflowEngine executes nodes in dependency order", async () => {
  const spec: WorkflowSpec = {
    version: 1,
    nodes: [
      {
        id: "title_en",
        type: "generate",
        section: "title",
        output_to: "title_en"
      },
      {
        id: "title_cn",
        type: "translate",
        depends_on: ["title_en"],
        input_from: "title_en",
        output_to: "title_cn"
      },
      {
        id: "render_cn",
        type: "render",
        depends_on: ["title_cn"],
        template: "cn",
        output_to: "cn_markdown"
      }
    ]
  };
  const graph = buildWorkflowGraph(spec);
  const ctx = new ExecutionContext();
  const registry = new FakeRegistry();
  const engine = new WorkflowEngine(graph, registry);

  await engine.run(ctx);

  assert.deepEqual(registry.calls, ["title_en", "title_cn", "render_cn"]);
  assert.equal(ctx.get("title_en"), "title_en");
  assert.equal(ctx.get("title_cn"), "title_cn:title_en");
  assert.equal(ctx.get("title_preview"), "preview-ready");
  assert.equal(ctx.get("cn_markdown"), "render_cn");
});

test("WorkflowEngine executes ready nodes in parallel batches", async () => {
  const spec: WorkflowSpec = {
    version: 1,
    nodes: [
      {
        id: "category_cn",
        type: "translate",
        input_from: "category",
        output_to: "category_cn"
      },
      {
        id: "keywords_cn",
        type: "translate",
        input_from: "keywords",
        output_to: "keywords_cn"
      },
      {
        id: "render_cn",
        type: "render",
        depends_on: ["category_cn", "keywords_cn"],
        template: "cn",
        output_to: "cn_markdown"
      }
    ]
  };
  const graph = buildWorkflowGraph(spec);
  const ctx = new ExecutionContext({
    category: "paper lanterns",
    keywords: "paper lanterns\nparty supplies"
  });
  const registry = new ParallelRegistry();
  const engine = new WorkflowEngine(graph, registry);

  await engine.run(ctx);

  assert.equal(registry.maxActive, 2);
});
