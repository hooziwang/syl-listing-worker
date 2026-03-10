import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { parse as parseYAML } from "yaml";
import type { WorkflowNode, WorkflowNodeType, WorkflowSpec } from "../workflow/types.js";

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

export interface WorkflowRules {
  spec: WorkflowSpec;
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

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

function parseWorkflowNodeType(value: unknown, path: string): WorkflowNodeType {
  const normalized = asString(value).trim().toLowerCase();
  switch (normalized) {
    case "generate":
    case "translate":
    case "derive":
    case "judge":
    case "render":
      return normalized;
    default:
      throw new Error(`规则缺失字段: ${path}`);
  }
}

function parseWorkflowNodes(v: unknown, path: string): WorkflowNode[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`规则缺失字段: ${path}`);
  }
  return v.map((item, index) => {
    const node = asRecord(item);
    if (!node) {
      throw new Error(`规则缺失字段: ${path}[${index}]`);
    }
    const parsed: WorkflowNode = {
      id: mustString(node.id, `${path}[${index}].id`),
      type: parseWorkflowNodeType(node.type, `${path}[${index}].type`),
      output_to: mustString(node.output_to, `${path}[${index}].output_to`)
    };
    const dependsOn = asStringArray(node.depends_on);
    if (dependsOn.length > 0) {
      parsed.depends_on = dependsOn;
    }
    const section = asString(node.section).trim();
    if (section) {
      parsed.section = section;
    }
    const inputFrom = asString(node.input_from).trim();
    if (inputFrom) {
      parsed.input_from = inputFrom;
    }
    const template = asString(node.template).trim();
    if (template) {
      parsed.template = template;
    }
    const inputsNode = asRecord(node.inputs);
    if (inputsNode) {
      const inputs: Record<string, string> = {};
      for (const [key, value] of Object.entries(inputsNode)) {
        const slot = asString(value).trim();
        if (key.trim() && slot) {
          inputs[key.trim()] = slot;
        }
      }
      if (Object.keys(inputs).length > 0) {
        parsed.inputs = inputs;
      }
    }
    const retryNode = asRecord(node.retry_policy);
    if (retryNode) {
      const maxAttempts = asNumber(retryNode.max_attempts, 0);
      if (maxAttempts > 0) {
        parsed.retry_policy = {
          max_attempts: Math.floor(maxAttempts)
        };
      }
    }
    return parsed;
  });
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

  const planningNode = (workflowDoc.planning as Record<string, unknown> | undefined) ?? {};
  const judgeNode = (workflowDoc.judge as Record<string, unknown> | undefined) ?? {};
  const translationNode = (workflowDoc.translation as Record<string, unknown> | undefined) ?? {};
  const renderNode = (workflowDoc.render as Record<string, unknown> | undefined) ?? {};
  const workflowNodes = parseWorkflowNodes(workflowDoc.nodes, "workflow.nodes");

  const workflow: WorkflowRules = {
    spec: {
      version: Math.max(1, asNumber(workflowDoc.version, 1)),
      nodes: workflowNodes
    },
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
      bullets_item_template: mustString(renderNode.bullets_item_template, "workflow.render.bullets_item_template"),
      bullets_separator: asString(renderNode.bullets_separator, "\n")
    },
    display_labels: (() => {
      const node = (workflowDoc.display_labels as Record<string, unknown> | undefined) ?? {};
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
    workflow,
    templates,
    sections
  };
  cache.set(key, parsed);
  return parsed;
}
