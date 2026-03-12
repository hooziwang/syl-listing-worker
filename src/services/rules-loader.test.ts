import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import { loadTenantRules } from "./rules-loader.js";

async function writeFixtureArchive(runtimePolicyPrefix = "", runtimePolicyDoc?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "syl-rules-loader-"));
  const tenantRoot = join(root, "tenant", "rules");
  await mkdir(join(tenantRoot, "sections"), { recursive: true });
  await mkdir(join(tenantRoot, "templates"), { recursive: true });

  await writeFile(join(tenantRoot, "package.yaml"), `required_sections:
  - title
  - bullets
  - description
  - search_terms
  - translation
templates:
  en: templates/en.md.tmpl
  cn: templates/cn.md.tmpl
`);
  await writeFile(join(tenantRoot, "input.yaml"), `file_discovery:
  marker: "===Listing Requirements==="
fields:
  - key: brand
    type: scalar
    capture: inline_label
    labels: ["品牌名"]
    fallback: UnknownBrand
    fallback_from_h1_first_token: true
  - key: keywords
    type: list
    capture: heading_section
    heading_aliases: ["关键词库"]
    min_count: 15
    unique_required: true
  - key: category
    type: scalar
    capture: heading_section
    heading_aliases: ["分类"]
`);
  await writeFile(join(tenantRoot, "generation-config.yaml"), `planning:
  enabled: true
  retries: 2
  system_prompt: plan
  user_prompt: plan
judge:
  enabled: true
  max_rounds: 1
  retries: 2
  system_prompt: judge
  user_prompt: judge
  ignore_messages: ["OK"]
  skip_sections: ["search_terms"]
translation:
  system_prompt: translate
render:
  keywords_item_template: "{{item}}"
  bullets_item_template: "{{item}}"
  bullets_separator: "\\n\\n"
display_labels:
  title: 标题
  bullets: 五点描述
  description: 产品描述
  search_terms: 搜索词
  category: 分类
  keywords: 关键词
`);
  await writeFile(join(tenantRoot, "templates", "en.md.tmpl"), "# EN\n{{title_en}}\n");
  await writeFile(join(tenantRoot, "templates", "cn.md.tmpl"), "# CN\n{{title_cn}}\n");
  await writeFile(
    join(root, "tenant", "runtime-policy.yaml"),
    runtimePolicyDoc ??
      `${runtimePolicyPrefix}intent:
  primary: maximize_parallelism
parallelism:
  section_concurrency: 3
specialists:
  - blueprint: section_planner
    model_profile: planner-fast
  - blueprint: title_writer
    model_profile: writer-fast
  - blueprint: bullets_writer
  - blueprint: description_writer
  - blueprint: translation_specialist
    model_profile: translator-fast
team_templates:
  - name: strict_review
    reviewer_required: true
    candidate_count: 2
    writer_model_profile: writer-template
    reviewer_model_profile: reviewer-template
    repairer_model_profile: repairer-template
section_overrides:
  - section: bullets
    team_template: strict_review
    candidate_count: 2
    writer_model_profile: writer-bullets
    reviewer_model_profile: reviewer-bullets
    repairer_model_profile: repairer-bullets
`
  );

  for (const section of ["title", "bullets", "description", "search_terms", "translation"]) {
    await writeFile(
      join(tenantRoot, "sections", `${section}.yaml`),
      `section: ${section}
language: en
instruction: ok
constraints: {}
execution:
  retries: 2
output:
  format: text
`
    );
  }

  const archivePath = join(root, "rules.tar.gz");
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

test("loadTenantRules loads generation config prompts and render config", async () => {
  const archivePath = await writeFixtureArchive();

  const rules = await loadTenantRules(archivePath, "demo", "rules-demo-v1");

  assert.equal(rules.generationConfig.planning.system_prompt, "plan");
  assert.equal(rules.generationConfig.judge.system_prompt, "judge");
  assert.equal(rules.generationConfig.translation.system_prompt, "translate");
  assert.equal(rules.generationConfig.render.bullets_separator, "\n\n");
});

test("loadTenantRules loads tenant runtime policy when present", async () => {
  const archivePath = await writeFixtureArchive();

  const rules = await loadTenantRules(archivePath, "demo-policy", "rules-demo-v2");

  assert.ok(rules.runtimePolicy);
  assert.equal("engine" in (rules.runtimePolicy ?? {}), false);
  assert.equal(rules.runtimePolicy?.intent?.primary, "maximize_parallelism");
  assert.equal(rules.runtimePolicy?.parallelism?.section_concurrency, 3);
  assert.equal(rules.runtimePolicy?.specialists?.length, 5);
  assert.deepEqual(rules.runtimePolicy?.specialists[0], {
    blueprint: "section_planner",
    model_profile: "planner-fast"
  });
  assert.deepEqual(rules.runtimePolicy?.specialists[1], {
    blueprint: "title_writer",
    model_profile: "writer-fast"
  });
  assert.equal(rules.runtimePolicy?.intent?.primary, "maximize_parallelism");
  assert.equal(rules.runtimePolicy?.parallelism?.section_concurrency, 3);
  assert.equal(rules.runtimePolicy?.handoffs, undefined);
  assert.equal(rules.runtimePolicy?.quality, undefined);
  assert.deepEqual(rules.runtimePolicy?.team_templates?.[0], {
    name: "strict_review",
    reviewer_required: true,
    candidate_count: 2,
    writer_model_profile: "writer-template",
    reviewer_model_profile: "reviewer-template",
    repairer_model_profile: "repairer-template"
  });
  assert.deepEqual(rules.runtimePolicy?.section_overrides?.[0], {
    section: "bullets",
    team_template: "strict_review",
    reviewer_required: undefined,
    candidate_count: 2,
    writer_model_profile: "writer-bullets",
    reviewer_model_profile: "reviewer-bullets",
    repairer_model_profile: "repairer-bullets"
  });
});

test("loadTenantRules tolerates legacy runtime policy engine field", async () => {
  const archivePath = await writeFixtureArchive("engine: runtime\n");

  const rules = await loadTenantRules(archivePath, "demo-legacy-policy", "rules-demo-v3");

  assert.ok(rules.runtimePolicy);
  assert.equal(rules.runtimePolicy?.intent?.primary, "maximize_parallelism");
  assert.equal(rules.runtimePolicy?.specialists?.[0]?.blueprint, "section_planner");
});

test("loadTenantRules leaves runtime policy intent and parallelism undefined when omitted", async () => {
  const archivePath = await writeFixtureArchive(
    "",
    `specialists:
  - blueprint: section_planner
    model_profile: planner-fast
  - blueprint: title_writer
    model_profile: writer-fast
  - blueprint: bullets_writer
  - blueprint: description_writer
  - blueprint: translation_specialist
    model_profile: translator-fast
`
  );

  const rules = await loadTenantRules(archivePath, "demo-no-runtime-defaults", "rules-demo-v5");

  assert.ok(rules.runtimePolicy);
  assert.equal(rules.runtimePolicy?.intent, undefined);
  assert.equal(rules.runtimePolicy?.parallelism, undefined);
});

test("loadTenantRules leaves runtime policy specialists undefined when omitted", async () => {
  const archivePath = await writeFixtureArchive(
    "",
    `section_overrides:
  - section: bullets
    team_template: strict_review
`
  );

  const rules = await loadTenantRules(archivePath, "demo-no-specialists", "rules-demo-v6");

  assert.ok(rules.runtimePolicy);
  assert.equal(rules.runtimePolicy?.specialists, undefined);
});

test("loadTenantRules tolerates legacy runtime policy handoffs field", async () => {
  const archivePath = await writeFixtureArchive(`handoffs:
  - from: section_planner
    to: title_writer
  - from: section_planner
    to: bullets_writer
`);

  const rules = await loadTenantRules(archivePath, "demo-legacy-handoffs", "rules-demo-v4");

  assert.deepEqual(rules.runtimePolicy?.handoffs, [
    { from: "section_planner", to: "title_writer" },
    { from: "section_planner", to: "bullets_writer" }
  ]);
});
