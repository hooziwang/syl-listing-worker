import type { ExecutionContext } from "../execution-context.js";
import type { NodeExecutionResult, NodeExecutor } from "../node-executor.js";
import type { WorkflowNode } from "../types.js";

function splitLines(input: string): string[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export class DeriveNodeExecutor implements NodeExecutor {
  constructor(
    private readonly handler?: (node: WorkflowNode, ctx: ExecutionContext) => Promise<NodeExecutionResult>
  ) {}

  supports(node: WorkflowNode): boolean {
    return node.type === "derive";
  }

  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult> {
    if (this.handler) {
      return this.handler(node, ctx);
    }
    if (node.section !== "search_terms") {
      throw new Error(`derive executor does not support section: ${node.section ?? ""}`);
    }
    const keywords = splitLines(ctx.get("keywords"));
    return {
      outputSlot: node.output_to,
      outputValue: keywords.join(" ")
    };
  }
}
