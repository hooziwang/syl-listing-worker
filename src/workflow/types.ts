export type WorkflowNodeType = "generate" | "translate" | "derive" | "judge" | "render";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  depends_on?: string[];
  section?: string;
  input_from?: string;
  inputs?: Record<string, string>;
  output_to: string;
  template?: string;
  retry_policy?: {
    max_attempts?: number;
  };
}

export interface WorkflowSpec {
  version: number;
  nodes: WorkflowNode[];
}

export interface WorkflowGraph {
  spec: WorkflowSpec;
  order: string[];
  nodes: Map<string, WorkflowNode>;
}
