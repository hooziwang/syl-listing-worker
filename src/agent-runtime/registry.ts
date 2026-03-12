import type {
  AgentBlueprint,
  AgentRuntimeRegistry,
  ModelProfile,
  RuntimeSpecialistPolicy,
  RuntimeSectionOverridePolicy,
  RuntimeSectionTeamTemplatePolicy
} from "./types.js";

function createBlueprint(blueprint: AgentBlueprint): AgentBlueprint {
  return blueprint;
}

function createModelProfile(profile: ModelProfile): ModelProfile {
  return profile;
}

export function createDefaultRegistry(): AgentRuntimeRegistry {
  const modelProfiles = new Map<string, ModelProfile>();
  for (const profile of [
    createModelProfile({
      id: "planner-default",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "runtime_plan"
    }),
    createModelProfile({
      id: "planner-fast",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "runtime_plan"
    }),
    createModelProfile({
      id: "writer-default",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "draft"
    }),
    createModelProfile({
      id: "writer-fast",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "draft"
    }),
    createModelProfile({
      id: "reviewer-default",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "review"
    }),
    createModelProfile({
      id: "reviewer-strict",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "review"
    }),
    createModelProfile({
      id: "repairer-default",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "repair"
    }),
    createModelProfile({
      id: "repairer-fast",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "repair"
    }),
    createModelProfile({
      id: "translator-default",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "translation"
    }),
    createModelProfile({
      id: "translator-fast",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "translation"
    })
  ]) {
    modelProfiles.set(profile.id, profile);
  }

  const blueprints = new Map<string, AgentBlueprint>();
  for (const blueprint of [
    createBlueprint({
      id: "section_planner",
      role: "planner",
      defaultModelProfile: "planner-fast",
      allowsHandoffs: true
    }),
    createBlueprint({
      id: "title_writer",
      role: "writer",
      sections: ["title"],
      defaultModelProfile: "writer-fast",
      supportsReviewer: true,
      maxCandidateCount: 2,
      allowsHandoffs: true
    }),
    createBlueprint({
      id: "bullets_writer",
      role: "writer",
      sections: ["bullets"],
      defaultModelProfile: "writer-fast",
      supportsReviewer: true,
      maxCandidateCount: 3,
      allowsHandoffs: true
    }),
    createBlueprint({
      id: "description_writer",
      role: "writer",
      sections: ["description"],
      defaultModelProfile: "writer-default",
      supportsReviewer: false,
      maxCandidateCount: 2,
      allowsHandoffs: true
    }),
    createBlueprint({
      id: "translation_specialist",
      role: "translator",
      defaultModelProfile: "translator-fast"
    }),
    createBlueprint({
      id: "reviewer",
      role: "reviewer",
      defaultModelProfile: "reviewer-strict",
      allowsHandoffs: true
    }),
    createBlueprint({
      id: "repairer",
      role: "repairer",
      defaultModelProfile: "repairer-fast"
    })
  ]) {
    blueprints.set(blueprint.id, blueprint);
  }

  const teamTemplates = new Map<string, RuntimeSectionTeamTemplatePolicy>();
  for (const template of [
    {
      name: "strict_review",
      reviewer_required: true,
      candidate_count: 2,
      writer_model_profile: "writer-default",
      reviewer_model_profile: "reviewer-default",
      repairer_model_profile: "repairer-default"
    }
  ]) {
    teamTemplates.set(template.name, template);
  }

  const defaultSpecialists: RuntimeSpecialistPolicy[] = [
    { blueprint: "section_planner" },
    { blueprint: "title_writer" },
    { blueprint: "bullets_writer" },
    { blueprint: "description_writer" },
    { blueprint: "translation_specialist" },
    { blueprint: "reviewer" },
    { blueprint: "repairer" }
  ];

  const defaultIntentPolicy = {
    primary: "maximize_parallelism"
  };

  const defaultParallelismPolicy = {
    section_concurrency: 4
  };

  const defaultQualityPolicy = {
    reviewer_required: true,
    max_review_rounds: 2
  };

  const defaultSectionOverrides = new Map<string, RuntimeSectionOverridePolicy>();
  for (const sectionOverride of [
    {
      section: "title",
      team_template: "strict_review",
      candidate_count: 1
    },
    {
      section: "description",
      reviewer_required: false,
      candidate_count: 1
    }
  ]) {
    defaultSectionOverrides.set(sectionOverride.section, sectionOverride);
  }

  const handoffs = [
    { from: "section_planner", to: "title_writer" },
    { from: "section_planner", to: "bullets_writer" },
    { from: "section_planner", to: "description_writer" },
    { from: "title_writer", to: "reviewer" },
    { from: "bullets_writer", to: "reviewer" },
    { from: "description_writer", to: "reviewer" },
    { from: "reviewer", to: "repairer" }
  ];

  return {
    blueprints,
    modelProfiles,
    teamTemplates,
    defaultSpecialists,
    defaultIntentPolicy,
    defaultParallelismPolicy,
    defaultQualityPolicy,
    defaultSectionOverrides,
    handoffs
  };
}
