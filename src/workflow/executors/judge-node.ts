import type { ExecutionContext } from "../execution-context.js";
import type { NodeExecutionResult, NodeExecutor } from "../node-executor.js";
import type { WorkflowNode } from "../types.js";

export class JudgeNodeExecutor implements NodeExecutor {
  constructor(private readonly handler: (node: WorkflowNode, ctx: ExecutionContext) => Promise<NodeExecutionResult>) {}

  supports(node: WorkflowNode): boolean {
    return node.type === "judge";
  }

  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult> {
    return this.handler(node, ctx);
  }
}
