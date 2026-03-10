import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowGraph } from "./graph.js";
import type { WorkflowSpec } from "./types.js";

test("buildWorkflowGraph returns topological order", () => {
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

  assert.deepEqual(graph.order, ["title_en", "title_cn", "render_cn"]);
});

test("buildWorkflowGraph rejects cyclic dependencies", () => {
  const spec: WorkflowSpec = {
    version: 1,
    nodes: [
      {
        id: "a",
        type: "generate",
        section: "title",
        depends_on: ["b"],
        output_to: "slot_a"
      },
      {
        id: "b",
        type: "generate",
        section: "bullets",
        depends_on: ["a"],
        output_to: "slot_b"
      }
    ]
  };

  assert.throws(() => buildWorkflowGraph(spec), /workflow cycle detected/i);
});
