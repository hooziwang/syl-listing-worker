import type { ExecutionContext } from "../execution-context.js";
import type { NodeExecutionResult, NodeExecutor } from "../node-executor.js";
import type { WorkflowNode } from "../types.js";

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

export class RenderNodeExecutor implements NodeExecutor {
  constructor(
    private readonly templates: { en: string; cn: string },
    private readonly handler?: (node: WorkflowNode, ctx: ExecutionContext) => Promise<NodeExecutionResult>
  ) {}

  supports(node: WorkflowNode): boolean {
    return node.type === "render";
  }

  async execute(node: WorkflowNode, ctx: ExecutionContext): Promise<NodeExecutionResult> {
    if (this.handler) {
      return this.handler(node, ctx);
    }
    const templateKey = (node.template ?? "").trim();
    if (templateKey !== "en" && templateKey !== "cn") {
      throw new Error(`render executor does not support template: ${templateKey}`);
    }
    const rendered = renderTemplate(this.templates[templateKey], ctx.snapshot()).trim();
    return {
      outputSlot: node.output_to,
      outputValue: rendered
    };
  }
}
