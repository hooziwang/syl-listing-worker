import type { TenantRules } from "../services/rules-loader.js";
import type {
  AgentBlueprint,
  AgentExecutionSpec,
  AgentRuntimeRegistry,
  RuntimeSectionOverridePolicy,
  RuntimeSectionTeamTemplatePolicy,
  RuntimeSpecialistPolicy,
  SectionExecutionPlan,
  TenantRuntimePolicy
} from "./types.js";

function requireRuntimePolicy(rules: TenantRules): TenantRuntimePolicy {
  if (!rules.runtimePolicy) {
    throw new Error("租户未启用 runtime policy");
  }
  return rules.runtimePolicy;
}

function requireRegisteredBlueprint(registry: AgentRuntimeRegistry, blueprintId: string): AgentBlueprint {
  const blueprint = registry.blueprints.get(blueprintId);
  if (!blueprint) {
    throw new Error(`未注册的 specialist blueprint: ${blueprintId}`);
  }
  return blueprint;
}

function requireRegisteredModelProfile(registry: AgentRuntimeRegistry, modelProfileId: string): string {
  if (!registry.modelProfiles.has(modelProfileId)) {
    throw new Error(`未注册的 model profile: ${modelProfileId}`);
  }
  return modelProfileId;
}

function findBlueprintForSection(
  specialists: RuntimeSpecialistPolicy[],
  registry: AgentRuntimeRegistry,
  section: string
): AgentBlueprint | undefined {
  for (const specialist of specialists) {
    const blueprint = requireRegisteredBlueprint(registry, specialist.blueprint);
    if (blueprint.role === "writer" && blueprint.sections?.includes(section)) {
      return blueprint;
    }
  }
  return undefined;
}

function findBlueprintByRole(
  specialists: RuntimeSpecialistPolicy[],
  registry: AgentRuntimeRegistry,
  role: AgentBlueprint["role"]
): AgentBlueprint | undefined {
  for (const specialist of specialists) {
    const blueprint = requireRegisteredBlueprint(registry, specialist.blueprint);
    if (blueprint.role === role) {
      return blueprint;
    }
  }
  return undefined;
}

function findSpecialistPolicy(
  specialists: RuntimeSpecialistPolicy[],
  blueprintId: string
): RuntimeSpecialistPolicy | undefined {
  return specialists.find((item) => item.blueprint === blueprintId);
}

function effectiveHandoffs(
  runtimePolicy: TenantRuntimePolicy,
  registry: AgentRuntimeRegistry
) {
  return runtimePolicy.handoffs && runtimePolicy.handoffs.length > 0 ? runtimePolicy.handoffs : registry.handoffs;
}

function effectiveQualityPolicy(
  runtimePolicy: TenantRuntimePolicy,
  registry: AgentRuntimeRegistry
) {
  return {
    reviewer_required:
      runtimePolicy.quality?.reviewer_required ?? registry.defaultQualityPolicy.reviewer_required ?? false,
    max_review_rounds:
      runtimePolicy.quality?.max_review_rounds ?? registry.defaultQualityPolicy.max_review_rounds ?? 0
  };
}

function effectiveIntentPolicy(
  runtimePolicy: TenantRuntimePolicy,
  registry: AgentRuntimeRegistry
) {
  return {
    primary: runtimePolicy.intent?.primary ?? registry.defaultIntentPolicy.primary
  };
}

function effectiveParallelismPolicy(
  runtimePolicy: TenantRuntimePolicy,
  registry: AgentRuntimeRegistry
) {
  return {
    section_concurrency:
      Math.max(1, runtimePolicy.parallelism?.section_concurrency ?? registry.defaultParallelismPolicy.section_concurrency)
  };
}

function effectiveSpecialists(
  runtimePolicy: TenantRuntimePolicy,
  registry: AgentRuntimeRegistry
): RuntimeSpecialistPolicy[] {
  const tenantSpecialists = runtimePolicy.specialists ?? [];
  if (tenantSpecialists.length === 0) {
    return registry.defaultSpecialists;
  }
  const merged = new Map<string, RuntimeSpecialistPolicy>();
  for (const specialist of registry.defaultSpecialists) {
    merged.set(specialist.blueprint, specialist);
  }
  for (const specialist of tenantSpecialists) {
    const previous = merged.get(specialist.blueprint);
    merged.set(specialist.blueprint, {
      blueprint: specialist.blueprint,
      model_profile: specialist.model_profile ?? previous?.model_profile
    });
  }
  return Array.from(merged.values());
}

function resolveSpecialistModelProfile(
  specialists: RuntimeSpecialistPolicy[],
  registry: AgentRuntimeRegistry,
  blueprint: AgentBlueprint
): string {
  const specialist = findSpecialistPolicy(specialists, blueprint.id);
  return requireRegisteredModelProfile(registry, specialist?.model_profile ?? blueprint.defaultModelProfile);
}

function chunkSections(sections: string[], chunkSize: number): string[][] {
  if (sections.length === 0) {
    return [];
  }
  const size = Math.max(1, chunkSize);
  const chunks: string[][] = [];
  for (let index = 0; index < sections.length; index += size) {
    chunks.push(sections.slice(index, index + size));
  }
  return chunks;
}

function mergeSectionOverride(
  defaultOverride: RuntimeSectionOverridePolicy | undefined,
  tenantOverride: RuntimeSectionOverridePolicy | undefined
) {
  if (!defaultOverride && !tenantOverride) {
    return undefined;
  }
  if (!defaultOverride) {
    return tenantOverride;
  }
  if (!tenantOverride) {
    return defaultOverride;
  }
  return {
    section: tenantOverride.section,
    team_template: tenantOverride.team_template ?? defaultOverride.team_template,
    reviewer_required: tenantOverride.reviewer_required ?? defaultOverride.reviewer_required,
    candidate_count: tenantOverride.candidate_count ?? defaultOverride.candidate_count,
    writer_model_profile: tenantOverride.writer_model_profile ?? defaultOverride.writer_model_profile,
    reviewer_model_profile: tenantOverride.reviewer_model_profile ?? defaultOverride.reviewer_model_profile,
    repairer_model_profile: tenantOverride.repairer_model_profile ?? defaultOverride.repairer_model_profile
  };
}

function getSectionOverride(
  runtimePolicy: TenantRuntimePolicy,
  registry: AgentRuntimeRegistry,
  section: string
) {
  return mergeSectionOverride(
    registry.defaultSectionOverrides.get(section),
    runtimePolicy.section_overrides?.find((item) => item.section === section)
  );
}

function findTeamTemplate(
  runtimePolicy: TenantRuntimePolicy,
  registry: AgentRuntimeRegistry,
  templateName: string | undefined
): RuntimeSectionTeamTemplatePolicy | undefined {
  if (!templateName) {
    return undefined;
  }
  return runtimePolicy.team_templates?.find((item) => item.name === templateName) ?? registry.teamTemplates.get(templateName);
}

function resolveSectionRoleModelProfile(
  registry: AgentRuntimeRegistry,
  fallbackModelProfile: string,
  overrideModelProfile?: string
): string {
  return requireRegisteredModelProfile(registry, overrideModelProfile ?? fallbackModelProfile);
}

export function compileExecutionSpec(
  rules: TenantRules,
  registry: AgentRuntimeRegistry
): AgentExecutionSpec {
  const runtimePolicy = requireRuntimePolicy(rules);
  const specialists = effectiveSpecialists(runtimePolicy, registry);
  const intentPolicy = effectiveIntentPolicy(runtimePolicy, registry);
  const parallelismPolicy = effectiveParallelismPolicy(runtimePolicy, registry);
  const qualityPolicy = effectiveQualityPolicy(runtimePolicy, registry);
  for (const specialist of specialists) {
    const blueprint = requireRegisteredBlueprint(registry, specialist.blueprint);
    if (specialist.model_profile) {
      resolveSpecialistModelProfile(specialists, registry, blueprint);
    }
  }
  for (const handoff of effectiveHandoffs(runtimePolicy, registry)) {
    requireRegisteredBlueprint(registry, handoff.from);
    requireRegisteredBlueprint(registry, handoff.to);
  }
  for (const template of runtimePolicy.team_templates ?? []) {
    if (template.writer_model_profile) {
      requireRegisteredModelProfile(registry, template.writer_model_profile);
    }
    if (template.reviewer_model_profile) {
      requireRegisteredModelProfile(registry, template.reviewer_model_profile);
    }
    if (template.repairer_model_profile) {
      requireRegisteredModelProfile(registry, template.repairer_model_profile);
    }
  }
  for (const template of registry.teamTemplates.values()) {
    if (template.writer_model_profile) {
      requireRegisteredModelProfile(registry, template.writer_model_profile);
    }
    if (template.reviewer_model_profile) {
      requireRegisteredModelProfile(registry, template.reviewer_model_profile);
    }
    if (template.repairer_model_profile) {
      requireRegisteredModelProfile(registry, template.repairer_model_profile);
    }
  }
  for (const sectionOverride of registry.defaultSectionOverrides.values()) {
    if (sectionOverride.writer_model_profile) {
      requireRegisteredModelProfile(registry, sectionOverride.writer_model_profile);
    }
    if (sectionOverride.reviewer_model_profile) {
      requireRegisteredModelProfile(registry, sectionOverride.reviewer_model_profile);
    }
    if (sectionOverride.repairer_model_profile) {
      requireRegisteredModelProfile(registry, sectionOverride.repairer_model_profile);
    }
  }

  const reviewerBlueprint = qualityPolicy.reviewer_required
    ? findBlueprintByRole(specialists, registry, "reviewer")
    : undefined;
  const plannerBlueprint = findBlueprintByRole(specialists, registry, "planner");
  const repairerBlueprint = findBlueprintByRole(specialists, registry, "repairer");
  const translationBlueprint = findBlueprintByRole(specialists, registry, "translator");
  if (!plannerBlueprint) {
    throw new Error("runtime policy 缺少 planner specialist");
  }
  if (!translationBlueprint) {
    throw new Error("runtime policy 缺少 translator specialist");
  }
  const plannerModelProfile = resolveSpecialistModelProfile(specialists, registry, plannerBlueprint);
  const translationModelProfile = resolveSpecialistModelProfile(specialists, registry, translationBlueprint);

  const sectionPlans = new Map<string, SectionExecutionPlan>();
  const executableSections: string[] = [];
  for (const section of rules.requiredSections) {
    if (section === "translation") {
      continue;
    }
    const sectionRule = rules.sections.get(section);
    if (!sectionRule) {
      continue;
    }
    const sectionOverride = getSectionOverride(runtimePolicy, registry, section);
    const teamTemplate = findTeamTemplate(runtimePolicy, registry, sectionOverride?.team_template);
    if (sectionOverride?.team_template && !teamTemplate) {
      throw new Error(`未注册的 team template: ${sectionOverride.team_template}`);
    }
    const candidateCount = Math.max(1, sectionOverride?.candidate_count ?? teamTemplate?.candidate_count ?? 1);
    const sectionReviewerRequired =
      sectionOverride?.reviewer_required ??
      teamTemplate?.reviewer_required ??
      qualityPolicy.reviewer_required;
    const effectiveReviewerBlueprint = sectionReviewerRequired ? reviewerBlueprint : undefined;
    if (section === "search_terms" && sectionRule.constraints.source === "keywords_copy") {
      sectionPlans.set(section, {
        section,
        mode: "derive",
        candidateCount
      });
      executableSections.push(section);
      continue;
    }
    const writerBlueprint = findBlueprintForSection(specialists, registry, section);
    if (!writerBlueprint) {
      throw new Error(`runtime policy 缺少 section writer: ${section}`);
    }
    if (candidateCount > (writerBlueprint.maxCandidateCount ?? 1)) {
      throw new Error(`${section} candidate_count=${candidateCount} 超过 blueprint 允许的候选上限`);
    }
    if (effectiveReviewerBlueprint && writerBlueprint.supportsReviewer === false) {
      throw new Error(`${writerBlueprint.id} 不支持 reviewer`);
    }
    sectionPlans.set(section, {
      section,
      mode: "generate",
      plannerBlueprint: plannerBlueprint.id,
      plannerModelProfile,
      writerBlueprint: writerBlueprint.id,
      writerModelProfile: resolveSectionRoleModelProfile(
        registry,
        resolveSpecialistModelProfile(specialists, registry, writerBlueprint),
        sectionOverride?.writer_model_profile ?? teamTemplate?.writer_model_profile
      ),
      reviewerBlueprint: effectiveReviewerBlueprint?.id,
      reviewerModelProfile: effectiveReviewerBlueprint
        ? resolveSectionRoleModelProfile(
            registry,
            resolveSpecialistModelProfile(specialists, registry, effectiveReviewerBlueprint),
            sectionOverride?.reviewer_model_profile ?? teamTemplate?.reviewer_model_profile
          )
        : undefined,
      repairerBlueprint: repairerBlueprint?.id,
      repairerModelProfile: repairerBlueprint
        ? resolveSectionRoleModelProfile(
            registry,
            resolveSpecialistModelProfile(specialists, registry, repairerBlueprint),
            sectionOverride?.repairer_model_profile ?? teamTemplate?.repairer_model_profile
          )
        : undefined,
      candidateCount
    });
    executableSections.push(section);
  }

  const parallelGroups =
    intentPolicy.primary === "maximize_parallelism"
      ? chunkSections(executableSections, parallelismPolicy.section_concurrency)
      : executableSections.map((section) => [section]);

  return {
    parallelGroups,
    sectionPlans,
    translationPlan: {
      blueprint: translationBlueprint.id,
      modelProfile: translationModelProfile
    },
    limits: {
      sectionConcurrency: parallelismPolicy.section_concurrency,
      maxReviewRounds: Math.max(0, qualityPolicy.max_review_rounds)
    }
  };
}
