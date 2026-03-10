import type { ExecutionContext } from "./execution-context.js";
import type { NodeExecutionResult } from "./node-executor.js";
import type { WorkflowGraph, WorkflowNode } from "./types.js";

export interface NodeExecutorRegistry {
  execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult>;
}

export class WorkflowEngine {
  constructor(
    private readonly graph: WorkflowGraph,
    private readonly registry: NodeExecutorRegistry
  ) {}

  async run(ctx: ExecutionContext): Promise<void> {
    const completed = new Set<string>();
    const remaining = [...this.graph.order];

    while (remaining.length > 0) {
      const ready = remaining.filter((nodeID) => {
        const node = this.graph.nodes.get(nodeID);
        if (!node) {
          throw new Error(`workflow node missing: ${nodeID}`);
        }
        const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
        return deps.every((dep) => completed.has(dep));
      });

      if (ready.length === 0) {
        throw new Error("workflow deadlock detected");
      }

      const results = await Promise.all(
        ready.map(async (nodeID) => {
          const node = this.graph.nodes.get(nodeID);
          if (!node) {
            throw new Error(`workflow node missing: ${nodeID}`);
          }
          const result = await this.registry.execute(node, ctx);
          return { nodeID, result };
        })
      );

      for (const { nodeID, result } of results) {
        ctx.set(result.outputSlot, result.outputValue);
        if (result.writes) {
          for (const [slot, value] of Object.entries(result.writes)) {
            ctx.set(slot, value);
          }
        }
        completed.add(nodeID);
      }

      for (const nodeID of ready) {
        const index = remaining.indexOf(nodeID);
        if (index >= 0) {
          remaining.splice(index, 1);
        }
      }
    }
  }
}
