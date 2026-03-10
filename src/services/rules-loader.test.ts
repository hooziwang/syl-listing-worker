import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import { loadTenantRules } from "./rules-loader.js";

async function writeFixtureArchive(): Promise<string> {
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
  await writeFile(join(tenantRoot, "workflow.yaml"), `planning:
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
nodes:
  - id: title_en
    type: generate
    section: title
    output_to: title_en
  - id: title_cn
    type: translate
    depends_on: [title_en]
    input_from: title_en
    output_to: title_cn
  - id: render_cn
    type: render
    depends_on: [title_cn]
    template: cn
    output_to: cn_markdown
`);
  await writeFile(join(tenantRoot, "templates", "en.md.tmpl"), "# EN\n{{title_en}}\n");
  await writeFile(join(tenantRoot, "templates", "cn.md.tmpl"), "# CN\n{{title_cn}}\n");

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

test("loadTenantRules loads workflow spec nodes", async () => {
  const archivePath = await writeFixtureArchive();

  const rules = await loadTenantRules(archivePath, "demo", "rules-demo-v1");

  assert.equal(rules.workflow.spec.version, 1);
  assert.equal(rules.workflow.spec.nodes.length, 3);
  assert.equal(rules.workflow.spec.nodes[0]?.id, "title_en");
  assert.equal(rules.workflow.spec.nodes[2]?.type, "render");
});
