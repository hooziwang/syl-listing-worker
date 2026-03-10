import type { ExecutionContext } from "./execution-context.js";
import type { NodeExecutionResult, NodeExecutor } from "./node-executor.js";
import type { WorkflowNode } from "./types.js";

export class ExecutorRegistry {
  constructor(private readonly executors: NodeExecutor[]) {}

  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult> {
    const executor = this.executors.find((item) => item.supports(node));
    if (!executor) {
      throw new Error(`no executor for workflow node: ${node.type}`);
    }
    return executor.execute(node, ctx);
  }
}
