import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultRegistry } from "./registry.js";

test("createDefaultRegistry registers planner profiles for runtime planning", () => {
  const registry = createDefaultRegistry();

  assert.equal(registry.modelProfiles.get("planner-default")?.purpose, "runtime_plan");
  assert.equal(registry.modelProfiles.get("planner-fast")?.purpose, "runtime_plan");
  assert.equal(registry.blueprints.get("section_planner")?.role, "planner");
  assert.equal(registry.blueprints.get("section_planner")?.defaultModelProfile, "planner-fast");
  assert.equal(registry.blueprints.get("title_writer")?.defaultModelProfile, "writer-fast");
  assert.equal(registry.blueprints.get("bullets_writer")?.defaultModelProfile, "writer-fast");
  assert.equal(registry.blueprints.get("description_writer")?.defaultModelProfile, "writer-default");
  assert.equal(registry.blueprints.get("translation_specialist")?.defaultModelProfile, "translator-fast");
  assert.equal(registry.blueprints.get("reviewer")?.defaultModelProfile, "reviewer-strict");
  assert.equal(registry.blueprints.get("repairer")?.defaultModelProfile, "repairer-fast");
  assert.deepEqual(registry.teamTemplates.get("strict_review"), {
    name: "strict_review",
    reviewer_required: true,
    candidate_count: 2,
    writer_model_profile: "writer-default",
    reviewer_model_profile: "reviewer-default",
    repairer_model_profile: "repairer-default"
  });
  assert.deepEqual(registry.defaultQualityPolicy, {
    reviewer_required: true,
    max_review_rounds: 2
  });
  assert.deepEqual(registry.defaultIntentPolicy, {
    primary: "maximize_parallelism"
  });
  assert.deepEqual(registry.defaultParallelismPolicy, {
    section_concurrency: 4
  });
  assert.deepEqual(registry.defaultSpecialists, [
    { blueprint: "section_planner" },
    { blueprint: "title_writer" },
    { blueprint: "bullets_writer" },
    { blueprint: "description_writer" },
    { blueprint: "translation_specialist" },
    { blueprint: "reviewer" },
    { blueprint: "repairer" }
  ]);
  assert.deepEqual(registry.defaultSectionOverrides.get("title"), {
    section: "title",
    team_template: "strict_review",
    candidate_count: 1
  });
  assert.deepEqual(registry.defaultSectionOverrides.get("description"), {
    section: "description",
    reviewer_required: false,
    candidate_count: 1
  });
  assert.deepEqual(registry.handoffs, [
    { from: "section_planner", to: "title_writer" },
    { from: "section_planner", to: "bullets_writer" },
    { from: "section_planner", to: "description_writer" },
    { from: "title_writer", to: "reviewer" },
    { from: "bullets_writer", to: "reviewer" },
    { from: "description_writer", to: "reviewer" },
    { from: "reviewer", to: "repairer" }
  ]);
});
