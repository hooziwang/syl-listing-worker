import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { parse as parseYAML } from "yaml";

export interface SectionRule {
  section: string;
  language: string;
  instruction: string;
  constraints: Record<string, unknown>;
  execution: {
    retries: number;
    repair_mode?: string;
  };
  output: {
    format: string;
    json_array_field?: string;
  };
}

export interface InputRules {
  brand: {
    labels: string[];
    fallback: string;
  };
  keywords: {
    heading_aliases: string[];
  };
  category: {
    heading_aliases: string[];
  };
}

export interface WorkflowRules {
  planning: {
    enabled: boolean;
    retries: number;
    system_prompt: string;
    user_prompt: string;
  };
  judge: {
    enabled: boolean;
    max_rounds: number;
    retries: number;
    system_prompt: string;
    user_prompt: string;
    ignore_messages: string[];
    skip_sections: string[];
  };
  translation: {
    system_prompt: string;
  };
  render: {
    keywords_item_template: string;
    bullets_item_template: string;
  };
}

export interface TemplateRules {
  en: string;
  cn: string;
}

export interface TenantRules {
  version: string;
  requiredSections: string[];
  input: InputRules;
  workflow: WorkflowRules;
  templates: TemplateRules;
  sections: Map<string, SectionRule>;
}

const cache = new Map<string, TenantRules>();

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(v)) {
    return fallback;
  }
  const out = v
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return out.length > 0 ? out : fallback;
}

function mustString(v: unknown, path: string): string {
  const s = asString(v).trim();
  if (!s) {
    throw new Error(`规则缺失字段: ${path}`);
  }
  return s;
}

function mustStringArray(v: unknown, path: string): string[] {
  const arr = asStringArray(v);
  if (arr.length === 0) {
    throw new Error(`规则缺失字段: ${path}`);
  }
  return arr;
}

async function readYAML(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYAML(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`规则文件格式错误: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

export async function loadTenantRules(
  archivePath: string,
  tenantId: string,
  rulesVersion: string
): Promise<TenantRules> {
  const key = `${tenantId}:${rulesVersion}`;
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const workdir = await mkdtemp(join(tmpdir(), `syl-rules-${tenantId}-${rulesVersion}-`));
  await extract({
    file: archivePath,
    cwd: workdir,
    gzip: true
  });

  const rulesDir = join(workdir, "tenant", "rules");
  const packageDoc = await readYAML(join(rulesDir, "package.yaml"));
  const inputDoc = await readYAML(join(rulesDir, "input.yaml"));
  const workflowDoc = await readYAML(join(rulesDir, "workflow.yaml"));

  const packageVersion = asString(packageDoc.version, rulesVersion);
  const requiredSections = asStringArray(packageDoc.required_sections, [
    "title",
    "bullets",
    "description",
    "search_terms",
    "translation"
  ]);
  const templatesNode = (packageDoc.templates as Record<string, unknown> | undefined) ?? {};
  const enTemplatePath = join(rulesDir, asString(templatesNode.en, "templates/en.md.tmpl"));
  const cnTemplatePath = join(rulesDir, asString(templatesNode.cn, "templates/cn.md.tmpl"));

  const templates: TemplateRules = {
    en: await readFile(enTemplatePath, "utf8"),
    cn: await readFile(cnTemplatePath, "utf8")
  };

  const input: InputRules = {
    brand: {
      labels: mustStringArray((inputDoc.brand as Record<string, unknown> | undefined)?.labels, "input.brand.labels"),
      fallback: mustString((inputDoc.brand as Record<string, unknown> | undefined)?.fallback, "input.brand.fallback")
    },
    keywords: {
      heading_aliases: mustStringArray(
        (inputDoc.keywords as Record<string, unknown> | undefined)?.heading_aliases,
        "input.keywords.heading_aliases"
      )
    },
    category: {
      heading_aliases: mustStringArray(
        (inputDoc.category as Record<string, unknown> | undefined)?.heading_aliases,
        "input.category.heading_aliases"
      )
    }
  };

  const planningNode = (workflowDoc.planning as Record<string, unknown> | undefined) ?? {};
  const judgeNode = (workflowDoc.judge as Record<string, unknown> | undefined) ?? {};
  const translationNode = (workflowDoc.translation as Record<string, unknown> | undefined) ?? {};
  const renderNode = (workflowDoc.render as Record<string, unknown> | undefined) ?? {};

  const workflow: WorkflowRules = {
    planning: {
      enabled: planningNode.enabled !== false,
      retries: Math.max(1, asNumber(planningNode.retries, 2)),
      system_prompt: mustString(planningNode.system_prompt, "workflow.planning.system_prompt"),
      user_prompt: mustString(planningNode.user_prompt, "workflow.planning.user_prompt")
    },
    judge: {
      enabled: judgeNode.enabled !== false,
      max_rounds: Math.max(0, asNumber(judgeNode.max_rounds, 2)),
      retries: Math.max(1, asNumber(judgeNode.retries, 2)),
      system_prompt: mustString(judgeNode.system_prompt, "workflow.judge.system_prompt"),
      user_prompt: mustString(judgeNode.user_prompt, "workflow.judge.user_prompt"),
      ignore_messages: mustStringArray(judgeNode.ignore_messages, "workflow.judge.ignore_messages"),
      skip_sections: mustStringArray(judgeNode.skip_sections, "workflow.judge.skip_sections")
    },
    translation: {
      system_prompt: mustString(translationNode.system_prompt, "workflow.translation.system_prompt")
    },
    render: {
      keywords_item_template: mustString(renderNode.keywords_item_template, "workflow.render.keywords_item_template"),
      bullets_item_template: mustString(renderNode.bullets_item_template, "workflow.render.bullets_item_template")
    }
  };

  const sectionsDir = join(rulesDir, "sections");
  const files = await readdir(sectionsDir);
  const sections = new Map<string, SectionRule>();

  for (const file of files) {
    if (!file.endsWith(".yaml")) {
      continue;
    }
    const raw = await readFile(join(sectionsDir, file), "utf8");
    const doc = parseYAML(raw) as Partial<SectionRule>;
    if (!doc || typeof doc.section !== "string" || typeof doc.instruction !== "string") {
      continue;
    }
    sections.set(doc.section, {
      section: doc.section,
      language: doc.language ?? "en",
      instruction: doc.instruction,
      constraints: (doc.constraints as Record<string, unknown>) ?? {},
      execution: {
        retries: asNumber((doc.execution as { retries?: unknown } | undefined)?.retries, 3),
        repair_mode: (doc.execution as { repair_mode?: string } | undefined)?.repair_mode
      },
      output: {
        format: (doc.output as { format?: string } | undefined)?.format ?? "text",
        json_array_field: (doc.output as { json_array_field?: string } | undefined)?.json_array_field
      }
    });
  }

  for (const section of requiredSections) {
    if (!sections.has(section)) {
      throw new Error(`规则文件缺失 section: ${section}`);
    }
  }

  const parsed: TenantRules = {
    version: packageVersion,
    requiredSections,
    input,
    workflow,
    templates,
    sections
  };
  cache.set(key, parsed);
  return parsed;
}
