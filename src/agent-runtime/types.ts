export interface RuntimeIntentPolicy {
  primary: string;
}

export interface RuntimeParallelismPolicy {
  section_concurrency: number;
}

export interface RuntimeSpecialistPolicy {
  blueprint: string;
  model_profile?: string;
}

export interface RuntimeHandoffPolicy {
  from: string;
  to: string;
}

export interface RuntimeQualityPolicy {
  reviewer_required?: boolean;
  max_review_rounds?: number;
}

export interface RuntimeSectionOverridePolicy {
  section: string;
  team_template?: string;
  reviewer_required?: boolean;
  candidate_count?: number;
  writer_model_profile?: string;
  reviewer_model_profile?: string;
  repairer_model_profile?: string;
}

export interface RuntimeSectionTeamTemplatePolicy {
  name: string;
  reviewer_required?: boolean;
  candidate_count?: number;
  writer_model_profile?: string;
  reviewer_model_profile?: string;
  repairer_model_profile?: string;
}

export interface TenantRuntimePolicy {
  intent?: RuntimeIntentPolicy;
  parallelism?: RuntimeParallelismPolicy;
  specialists?: RuntimeSpecialistPolicy[];
  handoffs?: RuntimeHandoffPolicy[];
  quality?: RuntimeQualityPolicy;
  team_templates?: RuntimeSectionTeamTemplatePolicy[];
  section_overrides?: RuntimeSectionOverridePolicy[];
}

export type AgentBlueprintRole =
  | "planner"
  | "writer"
  | "translator"
  | "reviewer"
  | "repairer"
  | "derive";

export interface ModelProfile {
  id: string;
  provider: "deepseek";
  model: string;
  purpose: "runtime_plan" | "draft" | "review" | "repair" | "translation";
}

export interface AgentBlueprint {
  id: string;
  role: AgentBlueprintRole;
  sections?: string[];
  defaultModelProfile: string;
  supportsReviewer?: boolean;
  maxCandidateCount?: number;
  allowsHandoffs?: boolean;
}

export interface AgentRuntimeRegistry {
  blueprints: Map<string, AgentBlueprint>;
  modelProfiles: Map<string, ModelProfile>;
  teamTemplates: Map<string, RuntimeSectionTeamTemplatePolicy>;
  defaultSpecialists: RuntimeSpecialistPolicy[];
  defaultIntentPolicy: RuntimeIntentPolicy;
  defaultParallelismPolicy: RuntimeParallelismPolicy;
  defaultQualityPolicy: RuntimeQualityPolicy;
  defaultSectionOverrides: Map<string, RuntimeSectionOverridePolicy>;
  handoffs: RuntimeHandoffPolicy[];
}

export interface SectionExecutionPlan {
  section: string;
  mode: "generate" | "derive";
  plannerBlueprint?: string;
  plannerModelProfile?: string;
  writerBlueprint?: string;
  writerModelProfile?: string;
  reviewerBlueprint?: string;
  reviewerModelProfile?: string;
  repairerBlueprint?: string;
  repairerModelProfile?: string;
  candidateCount: number;
}

export interface TranslationExecutionPlan {
  blueprint: string;
  modelProfile: string;
}

export interface AgentExecutionSpec {
  parallelGroups: string[][];
  sectionPlans: Map<string, SectionExecutionPlan>;
  translationPlan: TranslationExecutionPlan;
  limits: {
    sectionConcurrency: number;
    maxReviewRounds: number;
  };
}
