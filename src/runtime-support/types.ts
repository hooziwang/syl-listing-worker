export type GenerationNodeType = "generate" | "translate" | "derive" | "judge" | "render";

export interface GenerationNode {
  id: string;
  type: GenerationNodeType;
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
