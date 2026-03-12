import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create as createTar } from "tar";
import { compileExecutionSpec } from "./compiler.js";
import { createDefaultRegistry } from "./registry.js";
import { loadTenantRules, type TenantRules } from "../services/rules-loader.js";

function createFixtureRules(): TenantRules {
  return {
    requiredSections: ["title", "bullets", "description", "search_terms", "translation"],
    input: {
      file_discovery: { marker: "===Listing Requirements===" },
      fields: []
    },
    generationConfig: {
      planning: {
        enabled: true,
        retries: 2,
        system_prompt: "plan",
        user_prompt: "plan"
      },
      judge: {
        enabled: true,
        max_rounds: 2,
        retries: 2,
        system_prompt: "judge",
        user_prompt: "judge",
        ignore_messages: ["OK"],
        skip_sections: ["search_terms"]
      },
      translation: {
        system_prompt: "translate"
      },
      render: {
        keywords_item_template: "{{item}}",
        bullets_item_template: "{{item}}",
        bullets_separator: "\n"
      },
      display_labels: {}
    },
    templates: {
      en: "# EN\n{{title_en}}",
      cn: "# CN\n{{title_cn}}"
    },
    sections: new Map([
      [
        "title",
        {
          section: "title",
          language: "en",
          instruction: "title",
          constraints: {},
          execution: { retries: 2, generation_mode: "whole" },
          output: { format: "text" }
        }
      ],
      [
        "bullets",
        {
          section: "bullets",
          language: "en",
          instruction: "bullets",
          constraints: {},
          execution: { retries: 2, generation_mode: "whole" },
          output: { format: "json", json_array_field: "bullets" }
        }
      ],
      [
        "description",
        {
          section: "description",
          language: "en",
          instruction: "description",
          constraints: {},
          execution: { retries: 2, generation_mode: "whole" },
          output: { format: "markdown" }
        }
      ],
      [
        "search_terms",
        {
          section: "search_terms",
          language: "en",
          instruction: "search_terms",
          constraints: { source: "keywords_copy" },
          execution: { retries: 2, generation_mode: "whole" },
          output: { format: "text" }
        }
      ],
      [
        "translation",
        {
          section: "translation",
          language: "zh",
          instruction: "translation",
          constraints: {},
          execution: { retries: 2, generation_mode: "whole" },
          output: { format: "text" }
        }
      ]
    ]),
    runtimePolicy: {
      intent: {
        primary: "maximize_parallelism"
      },
      parallelism: {
        section_concurrency: 4
      },
      specialists: [
        { blueprint: "section_planner" },
        { blueprint: "title_writer" },
        { blueprint: "bullets_writer" },
        { blueprint: "description_writer" },
        { blueprint: "translation_specialist" },
        { blueprint: "reviewer" },
        { blueprint: "repairer" }
      ],
      handoffs: [
        { from: "section_planner", to: "title_writer" },
        { from: "section_planner", to: "bullets_writer" },
        { from: "section_planner", to: "description_writer" },
        { from: "title_writer", to: "reviewer" },
        { from: "bullets_writer", to: "reviewer" },
        { from: "description_writer", to: "reviewer" },
        { from: "reviewer", to: "repairer" }
      ],
      quality: {
        reviewer_required: true,
        max_review_rounds: 2
      },
      section_overrides: [
        {
          section: "description",
          reviewer_required: false
        },
        {
          section: "bullets",
          candidate_count: 3
        }
      ]
    }
  };
}

async function createArchiveFromTenantFixture(tenant: "demo" | "syl"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `syl-agent-runtime-${tenant}-`));
  const tenantRoot = join(root, "tenant");
  const sourceRoot = resolve(process.cwd(), "..", "rules", "tenants", tenant);
  await mkdir(tenantRoot, { recursive: true });
  await cp(join(sourceRoot, "rules"), join(tenantRoot, "rules"), { recursive: true });
  await cp(join(sourceRoot, "runtime-policy.yaml"), join(tenantRoot, "runtime-policy.yaml"));
  const archivePath = join(root, `${tenant}.tar.gz`);
  await createTar(
    {
      gzip: true,
      cwd: root,
      file: archivePath
    },
    ["tenant"]
  );
  return archivePath;
}

test("compileExecutionSpec builds a runtime section plan", () => {
  const spec = compileExecutionSpec(createFixtureRules(), createDefaultRegistry());

  assert.equal("engine" in spec, false);
  assert.equal(spec.parallelGroups.length, 1);
  assert.deepEqual(spec.parallelGroups[0], ["title", "bullets", "description", "search_terms"]);
  assert.equal(spec.sectionPlans.get("title")?.plannerBlueprint, "section_planner");
  assert.equal(spec.sectionPlans.get("title")?.plannerModelProfile, "planner-fast");
  assert.equal(spec.sectionPlans.get("title")?.writerBlueprint, "title_writer");
  assert.equal(spec.sectionPlans.get("title")?.writerModelProfile, "writer-default");
  assert.equal(spec.sectionPlans.get("bullets")?.reviewerBlueprint, "reviewer");
  assert.equal(spec.sectionPlans.get("bullets")?.reviewerModelProfile, "reviewer-strict");
  assert.equal(spec.sectionPlans.get("bullets")?.candidateCount, 3);
  assert.equal(spec.sectionPlans.get("bullets")?.repairerModelProfile, "repairer-fast");
  assert.equal(spec.sectionPlans.get("description")?.reviewerBlueprint, undefined);
  assert.equal(spec.translationPlan.blueprint, "translation_specialist");
  assert.equal(spec.translationPlan.modelProfile, "translator-fast");
});

test("compileExecutionSpec falls back to registry default quality policy", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    quality: undefined
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.reviewerBlueprint, "reviewer");
  assert.equal(spec.sectionPlans.get("description")?.reviewerBlueprint, undefined);
  assert.equal(spec.limits.maxReviewRounds, 2);
});

test("compileExecutionSpec falls back to registry default runtime policy", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    intent: undefined as never,
    parallelism: undefined as never
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.deepEqual(spec.parallelGroups[0], ["title", "bullets", "description", "search_terms"]);
  assert.equal(spec.limits.sectionConcurrency, 4);
});

test("compileExecutionSpec falls back to registry default specialists", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    specialists: undefined as never
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.plannerBlueprint, "section_planner");
  assert.equal(spec.sectionPlans.get("title")?.writerBlueprint, "title_writer");
  assert.equal(spec.translationPlan.blueprint, "translation_specialist");
});

test("compileExecutionSpec falls back to registry default section overrides", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    section_overrides: [
      {
        section: "bullets",
        candidate_count: 3
      }
    ]
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.candidateCount, 1);
  assert.equal(spec.sectionPlans.get("title")?.reviewerBlueprint, "reviewer");
  assert.equal(spec.sectionPlans.get("description")?.candidateCount, 1);
  assert.equal(spec.sectionPlans.get("description")?.reviewerBlueprint, undefined);
});

test("compileExecutionSpec honors specialist model_profile overrides", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    specialists: [
      { blueprint: "section_planner", model_profile: "planner-default" },
      { blueprint: "title_writer", model_profile: "writer-default" },
      { blueprint: "bullets_writer", model_profile: "writer-default" },
      { blueprint: "description_writer" },
      { blueprint: "translation_specialist", model_profile: "translator-default" },
      { blueprint: "reviewer", model_profile: "reviewer-default" },
      { blueprint: "repairer", model_profile: "repairer-default" }
    ]
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.plannerModelProfile, "planner-default");
  assert.equal(spec.sectionPlans.get("title")?.writerModelProfile, "writer-default");
  assert.equal(spec.sectionPlans.get("title")?.reviewerModelProfile, "reviewer-default");
  assert.equal(spec.sectionPlans.get("title")?.repairerModelProfile, "repairer-default");
  assert.equal(spec.translationPlan.modelProfile, "translator-default");
});

test("compileExecutionSpec lets tenant specialists override registry defaults", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    specialists: [
      { blueprint: "section_planner", model_profile: "planner-default" },
      { blueprint: "title_writer", model_profile: "writer-default" }
    ]
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.plannerModelProfile, "planner-default");
  assert.equal(spec.sectionPlans.get("title")?.writerModelProfile, "writer-default");
  assert.equal(spec.sectionPlans.get("bullets")?.writerModelProfile, "writer-fast");
  assert.equal(spec.translationPlan.modelProfile, "translator-fast");
});

test("compileExecutionSpec lets section_overrides override section model profiles", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    section_overrides: [
      {
        section: "bullets",
        candidate_count: 2,
        writer_model_profile: "writer-default",
        reviewer_model_profile: "reviewer-default",
        repairer_model_profile: "repairer-default"
      },
      {
        section: "description",
        reviewer_required: false
      }
    ]
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.writerModelProfile, "writer-default");
  assert.equal(spec.sectionPlans.get("bullets")?.writerModelProfile, "writer-default");
  assert.equal(spec.sectionPlans.get("bullets")?.reviewerModelProfile, "reviewer-default");
  assert.equal(spec.sectionPlans.get("bullets")?.repairerModelProfile, "repairer-default");
});

test("compileExecutionSpec lets tenant quality override registry defaults", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    quality: {
      reviewer_required: false,
      max_review_rounds: 1
    },
    section_overrides: [
      {
        section: "bullets",
        candidate_count: 2
      }
    ]
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.reviewerBlueprint, undefined);
  assert.equal(spec.sectionPlans.get("bullets")?.reviewerBlueprint, undefined);
  assert.equal(spec.limits.maxReviewRounds, 1);
});

test("compileExecutionSpec lets tenant runtime policy override registry defaults", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    intent: {
      primary: "serial"
    },
    parallelism: {
      section_concurrency: 2
    }
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.deepEqual(spec.parallelGroups, [["title"], ["bullets"], ["description"], ["search_terms"]]);
  assert.equal(spec.limits.sectionConcurrency, 2);
});

test("compileExecutionSpec lets tenant section overrides extend registry defaults", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    section_overrides: [
      {
        section: "title",
        candidate_count: 2,
        reviewer_required: false
      },
      {
        section: "bullets",
        candidate_count: 3
      },
      {
        section: "description",
        reviewer_required: false
      }
    ]
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.candidateCount, 2);
  assert.equal(spec.sectionPlans.get("title")?.reviewerBlueprint, undefined);
});

test("compileExecutionSpec applies team template before section-level overrides", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    team_templates: [
      {
        name: "strict_review",
        reviewer_required: true,
        candidate_count: 2,
        writer_model_profile: "writer-default",
        reviewer_model_profile: "reviewer-default",
        repairer_model_profile: "repairer-default"
      }
    ],
    section_overrides: [
      {
        section: "title",
        team_template: "strict_review"
      },
      {
        section: "bullets",
        team_template: "strict_review",
        candidate_count: 3,
        writer_model_profile: "writer-fast"
      },
      {
        section: "description",
        reviewer_required: false
      }
    ]
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.candidateCount, 1);
  assert.equal(spec.sectionPlans.get("title")?.writerModelProfile, "writer-default");
  assert.equal(spec.sectionPlans.get("title")?.reviewerModelProfile, "reviewer-default");
  assert.equal(spec.sectionPlans.get("title")?.repairerModelProfile, "repairer-default");
  assert.equal(spec.sectionPlans.get("bullets")?.candidateCount, 3);
  assert.equal(spec.sectionPlans.get("bullets")?.writerModelProfile, "writer-fast");
  assert.equal(spec.sectionPlans.get("bullets")?.reviewerModelProfile, "reviewer-default");
  assert.equal(spec.sectionPlans.get("description")?.reviewerModelProfile, undefined);
});

test("compileExecutionSpec rejects unknown team template", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    section_overrides: [
      {
        section: "title",
        team_template: "missing_template"
      },
      {
        section: "description",
        reviewer_required: false
      }
    ]
  };

  assert.throws(
    () => compileExecutionSpec(rules, createDefaultRegistry()),
    /未注册的 team template/
  );
});

test("compileExecutionSpec rejects unregistered section override model_profile", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    section_overrides: [
      {
        section: "bullets",
        writer_model_profile: "writer-missing"
      },
      {
        section: "description",
        reviewer_required: false
      }
    ]
  };

  assert.throws(
    () => compileExecutionSpec(rules, createDefaultRegistry()),
    /未注册的 model profile/
  );
});

test("compileExecutionSpec rejects unregistered specialist model_profile", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    specialists: (rules.runtimePolicy!.specialists ?? []).map((item) =>
      item.blueprint === "title_writer" ? { ...item, model_profile: "writer-missing" } : item
    )
  };

  assert.throws(
    () => compileExecutionSpec(rules, createDefaultRegistry()),
    /未注册的 model profile/
  );
});

test("compileExecutionSpec inherits planner specialist from registry defaults", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    specialists: (rules.runtimePolicy!.specialists ?? []).filter((item) => item.blueprint !== "section_planner")
  };

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.plannerBlueprint, "section_planner");
  assert.equal(spec.sectionPlans.get("title")?.plannerModelProfile, "planner-fast");
});

test("compileExecutionSpec rejects unregistered blueprints", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    specialists: [{ blueprint: "unknown_writer" }]
  };

  assert.throws(
    () => compileExecutionSpec(rules, createDefaultRegistry()),
    /未注册的 specialist blueprint/
  );
});

test("compileExecutionSpec rejects candidate_count beyond writer blueprint limit", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    section_overrides: [
      {
        section: "bullets",
        candidate_count: 5
      }
    ]
  };

  assert.throws(
    () => compileExecutionSpec(rules, createDefaultRegistry()),
    /超过 blueprint 允许的候选上限/
  );
});

test("compileExecutionSpec rejects reviewer requirement when writer blueprint forbids reviewer", () => {
  const rules = createFixtureRules();
  rules.runtimePolicy = {
    ...rules.runtimePolicy!,
    section_overrides: [
      {
        section: "description",
        reviewer_required: true
      }
    ]
  };

  assert.throws(
    () => compileExecutionSpec(rules, createDefaultRegistry()),
    /不支持 reviewer/
  );
});

test("compileExecutionSpec honors section overrides from runtime-policy fixture", async () => {
  const archivePath = await createArchiveFromTenantFixture("demo");
  const rules = await loadTenantRules(archivePath, "demo-runtime", "rules-demo-runtime-team-template");

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("title")?.reviewerBlueprint, "reviewer");
  assert.equal(spec.sectionPlans.get("description")?.reviewerBlueprint, undefined);
  assert.equal(spec.sectionPlans.get("bullets")?.candidateCount, 2);
});

test("compileExecutionSpec uses two bullets candidates for syl runtime policy", async () => {
  const archivePath = await createArchiveFromTenantFixture("syl");
  const rules = await loadTenantRules(archivePath, "syl-runtime", "rules-syl-runtime-candidate-count");

  const spec = compileExecutionSpec(rules, createDefaultRegistry());

  assert.equal(spec.sectionPlans.get("bullets")?.candidateCount, 2);
});
