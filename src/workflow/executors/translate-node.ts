import type { ExecutionContext } from "../execution-context.js";
import type { NodeExecutionResult, NodeExecutor } from "../node-executor.js";
import type { WorkflowNode } from "../types.js";

export class TranslateNodeExecutor implements NodeExecutor {
  constructor(private readonly handler: (node: WorkflowNode, ctx: ExecutionContext) => Promise<string>) {}

  supports(node: WorkflowNode): boolean {
    return node.type === "translate";
  }

  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult> {
    return {
      outputSlot: node.output_to,
      outputValue: await this.handler(node, ctx)
    };
  }
}
