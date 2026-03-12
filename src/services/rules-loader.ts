import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { parse as parseYAML } from "yaml";
import type { TenantRuntimePolicy } from "../agent-runtime/types.js";

export interface SectionRule {
  section: string;
  language: string;
  instruction: string;
  constraints: Record<string, unknown>;
  execution: {
    retries: number;
    repair_mode?: string;
    generation_mode: "whole" | "sentence";
    sentence_count?: number;
    paragraph_count?: number;
  };
  output: {
    format: string;
    json_array_field?: string;
  };
}

export interface InputRules {
  file_discovery: {
    marker: string;
  };
  fields: InputFieldRule[];
}

export interface InputFieldRule {
  key: string;
  type: "scalar" | "list";
  capture: "inline_label" | "heading_section";
  labels?: string[];
  heading_aliases?: string[];
  required?: boolean;
  fallback?: string;
  fallback_from_h1_first_token?: boolean;
  min_count?: number;
  unique_required?: boolean;
}

export interface GenerationConfig {
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
    bullets_separator: string;
  };
  display_labels: Record<string, string>;
}

export interface TemplateRules {
  en: string;
  cn: string;
}

export interface TenantRules {
  requiredSections: string[];
  input: InputRules;
  generationConfig: GenerationConfig;
  templates: TemplateRules;
  sections: Map<string, SectionRule>;
  runtimePolicy?: TenantRuntimePolicy;
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

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

async function readYAML(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYAML(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`规则文件格式错误: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

async function readOptionalYAML(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await readYAML(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("读取配置文件失败")) {
      return undefined;
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    if (message.includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function parseRuntimePolicy(doc: Record<string, unknown> | undefined): TenantRuntimePolicy | undefined {
  if (!doc) {
    return undefined;
  }
  const engine = asString(doc.engine).trim().toLowerCase();
  if (engine && engine !== "runtime") {
    throw new Error("runtime_policy.engine 只支持 runtime");
  }
  const intentNode = asRecord(doc.intent);
  const parallelismNode = asRecord(doc.parallelism);
  const qualityNode = asRecord(doc.quality);
  const specialists = Array.isArray(doc.specialists)
    ? doc.specialists
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => !!item)
        .map((item) => ({
          blueprint: mustString(item.blueprint, "runtime_policy.specialists[].blueprint"),
          model_profile: asString(item.model_profile).trim() || undefined
        }))
    : undefined;
  const handoffs = Array.isArray(doc.handoffs)
    ? doc.handoffs
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => !!item)
        .map((item) => ({
          from: mustString(item.from, "runtime_policy.handoffs[].from"),
          to: mustString(item.to, "runtime_policy.handoffs[].to")
        }))
    : undefined;
  const teamTemplates = Array.isArray(doc.team_templates)
    ? doc.team_templates
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => !!item)
        .map((item) => ({
          name: mustString(item.name, "runtime_policy.team_templates[].name"),
          reviewer_required:
            typeof item.reviewer_required === "boolean" ? item.reviewer_required : undefined,
          candidate_count:
            typeof item.candidate_count === "number" && Number.isFinite(item.candidate_count)
              ? Math.max(1, item.candidate_count)
              : undefined,
          writer_model_profile: asString(item.writer_model_profile).trim() || undefined,
          reviewer_model_profile: asString(item.reviewer_model_profile).trim() || undefined,
          repairer_model_profile: asString(item.repairer_model_profile).trim() || undefined
        }))
    : undefined;
  return {
    intent: intentNode
      ? {
          primary: mustString(intentNode.primary, "runtime_policy.intent.primary")
        }
      : undefined,
    parallelism: parallelismNode
      ? {
          section_concurrency: Math.max(1, asNumber(parallelismNode.section_concurrency, 1))
        }
      : undefined,
    specialists,
    handoffs,
    team_templates: teamTemplates,
    quality: qualityNode
      ? {
          reviewer_required:
            typeof qualityNode.reviewer_required === "boolean" ? qualityNode.reviewer_required : undefined,
          max_review_rounds:
            typeof qualityNode.max_review_rounds === "number" && Number.isFinite(qualityNode.max_review_rounds)
              ? Math.max(0, qualityNode.max_review_rounds)
              : undefined
        }
      : undefined,
    section_overrides: Array.isArray(doc.section_overrides)
      ? doc.section_overrides
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => !!item)
          .map((item) => ({
            section: mustString(item.section, "runtime_policy.section_overrides[].section"),
            team_template: asString(item.team_template).trim() || undefined,
            reviewer_required:
              typeof item.reviewer_required === "boolean" ? item.reviewer_required : undefined,
            candidate_count:
              typeof item.candidate_count === "number" && Number.isFinite(item.candidate_count)
                ? Math.max(1, item.candidate_count)
                : undefined,
            writer_model_profile: asString(item.writer_model_profile).trim() || undefined,
            reviewer_model_profile: asString(item.reviewer_model_profile).trim() || undefined,
            repairer_model_profile: asString(item.repairer_model_profile).trim() || undefined
          }))
      : undefined
  };
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

  const runtimePolicyDoc = await readOptionalYAML(join(workdir, "tenant", "runtime-policy.yaml"));
  const rulesDir = join(workdir, "tenant", "rules");
  const packageDoc = await readYAML(join(rulesDir, "package.yaml"));
  const inputDoc = await readYAML(join(rulesDir, "input.yaml"));
  const generationConfigDoc = await readYAML(join(rulesDir, "generation-config.yaml"));

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
    file_discovery: {
      marker: mustString(
        (inputDoc.file_discovery as Record<string, unknown> | undefined)?.marker,
        "input.file_discovery.marker"
      )
    },
    fields: (() => {
      const raw = inputDoc.fields;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("规则缺失字段: input.fields");
      }
      return raw.map((item, index) => {
        const field = asRecord(item);
        if (!field) {
          throw new Error(`规则缺失字段: input.fields[${index}]`);
        }
        const typeRaw = mustString(field.type, `input.fields[${index}].type`).trim().toLowerCase();
        const captureRaw = mustString(field.capture, `input.fields[${index}].capture`).trim().toLowerCase();
        const type: "scalar" | "list" = typeRaw === "list" ? "list" : "scalar";
        const capture: "inline_label" | "heading_section" =
          captureRaw === "heading_section" ? "heading_section" : "inline_label";
        return {
          key: mustString(field.key, `input.fields[${index}].key`),
          type,
          capture,
          labels: asStringArray(field.labels),
          heading_aliases: asStringArray(field.heading_aliases),
          required: field.required !== false,
          fallback: asString(field.fallback).trim(),
          fallback_from_h1_first_token: field.fallback_from_h1_first_token === true,
          min_count: Math.max(0, asNumber(field.min_count, 0)),
          unique_required: field.unique_required === true
        };
      });
    })()
  };

  const planningNode = (generationConfigDoc.planning as Record<string, unknown> | undefined) ?? {};
  const judgeNode = (generationConfigDoc.judge as Record<string, unknown> | undefined) ?? {};
  const translationNode = (generationConfigDoc.translation as Record<string, unknown> | undefined) ?? {};
  const renderNode = (generationConfigDoc.render as Record<string, unknown> | undefined) ?? {};
  const generationConfig: GenerationConfig = {
    planning: {
      enabled: planningNode.enabled !== false,
      retries: Math.max(1, asNumber(planningNode.retries, 2)),
      system_prompt: mustString(planningNode.system_prompt, "generation_config.planning.system_prompt"),
      user_prompt: mustString(planningNode.user_prompt, "generation_config.planning.user_prompt")
    },
    judge: {
      enabled: judgeNode.enabled !== false,
      max_rounds: Math.max(0, asNumber(judgeNode.max_rounds, 2)),
      retries: Math.max(1, asNumber(judgeNode.retries, 2)),
      system_prompt: mustString(judgeNode.system_prompt, "generation_config.judge.system_prompt"),
      user_prompt: mustString(judgeNode.user_prompt, "generation_config.judge.user_prompt"),
      ignore_messages: mustStringArray(judgeNode.ignore_messages, "generation_config.judge.ignore_messages"),
      skip_sections: mustStringArray(judgeNode.skip_sections, "generation_config.judge.skip_sections")
    },
    translation: {
      system_prompt: mustString(translationNode.system_prompt, "generation_config.translation.system_prompt")
    },
    render: {
      keywords_item_template: mustString(
        renderNode.keywords_item_template,
        "generation_config.render.keywords_item_template"
      ),
      bullets_item_template: mustString(
        renderNode.bullets_item_template,
        "generation_config.render.bullets_item_template"
      ),
      bullets_separator: asString(renderNode.bullets_separator, "\n")
    },
    display_labels: (() => {
      const node = (generationConfigDoc.display_labels as Record<string, unknown> | undefined) ?? {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(node)) {
        const key = String(k).trim();
        const value = asString(v).trim();
        if (key && value) {
          out[key] = value;
        }
      }
      return out;
    })()
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
    const executionNode = (doc.execution as Record<string, unknown> | undefined) ?? {};
    const sentenceModeNode = (executionNode.sentence_mode as Record<string, unknown> | undefined) ?? {};
    const generationModeRaw = asString(
      executionNode.generation_mode,
      sentenceModeNode.enabled === true ? "sentence" : "whole"
    )
      .trim()
      .toLowerCase();
    const generationMode: "whole" | "sentence" = generationModeRaw === "sentence" ? "sentence" : "whole";
    const sentenceCountValue = asNumber(executionNode.sentence_count, asNumber(sentenceModeNode.sentence_count, 0));
    const paragraphCountValue = asNumber(executionNode.paragraph_count, asNumber(sentenceModeNode.paragraph_count, 0));
    const sentenceCount = Number.isFinite(sentenceCountValue) && sentenceCountValue > 0
      ? Math.floor(sentenceCountValue)
      : undefined;
    const paragraphCount = Number.isFinite(paragraphCountValue) && paragraphCountValue > 0
      ? Math.floor(paragraphCountValue)
      : undefined;
    sections.set(doc.section, {
      section: doc.section,
      language: doc.language ?? "en",
      instruction: doc.instruction,
      constraints: (doc.constraints as Record<string, unknown>) ?? {},
      execution: {
        retries: asNumber((doc.execution as { retries?: unknown } | undefined)?.retries, 3),
        repair_mode: (doc.execution as { repair_mode?: string } | undefined)?.repair_mode,
        generation_mode: generationMode,
        sentence_count: sentenceCount,
        paragraph_count: paragraphCount
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
    requiredSections,
    input,
    generationConfig,
    templates,
    sections,
    runtimePolicy: parseRuntimePolicy(runtimePolicyDoc)
  };
  cache.set(key, parsed);
  return parsed;
}
