import type { ExecutionContext } from "./execution-context.js";
import type { WorkflowNode } from "./types.js";

export interface NodeExecutionResult {
  outputSlot: string;
  outputValue: string;
  writes?: Record<string, string>;
}

export interface NodeExecutor {
  supports(node: WorkflowNode): boolean;
  execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult>;
}
