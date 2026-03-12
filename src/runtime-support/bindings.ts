import type { InputFieldRule, SectionRule } from "../services/rules-loader.js";
import type { ExecutionContext } from "./execution-context.js";
import type { GenerationNode } from "./types.js";

type RenderConfig = {
  keywords_item_template: string;
  bullets_item_template: string;
  bullets_separator: string;
};

type RenderVariablesOptions = {
  inputFields: InputFieldRule[];
  sections: Map<string, SectionRule>;
  render: RenderConfig;
};

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

function stripBulletPrefix(line: string): string {
  return line.replace(/^[-*•\d\s.)]+/, "").trim();
}

function splitLines(input: string): string[] {
  return normalizeText(input)
    .split("\n")
    .map((line) => stripBulletPrefix(line))
    .filter(Boolean);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

function renderList(items: string[], itemTemplate: string, separator = "\n"): string {
  return items
    .map((item, index) =>
      renderTemplate(itemTemplate, {
        index: String(index + 1),
        item
      })
    )
    .join(separator);
}

function slotSectionKey(slot: string): string {
  const normalized = slot.trim();
  if (!normalized) {
    return "";
  }
  return normalized.replace(/_(en|cn)$/i, "");
}

function isListInputSlot(slot: string, inputFields: InputFieldRule[]): boolean {
  const key = slotSectionKey(slot);
  return inputFields.some((field) => field.key === key && field.type === "list");
}

function isLineBasedSectionSlot(slot: string, sections: Map<string, SectionRule>): boolean {
  const key = slotSectionKey(slot);
  const rule = sections.get(key);
  if (!rule) {
    return false;
  }
  const lineCount = rule.constraints.line_count;
  return typeof lineCount === "number" && Number.isFinite(lineCount) && lineCount > 0;
}

function formatSlotValue(slot: string, raw: string, options: RenderVariablesOptions): string {
  if (isListInputSlot(slot, options.inputFields)) {
    return renderList(splitLines(raw), options.render.keywords_item_template);
  }
  if (isLineBasedSectionSlot(slot, options.sections)) {
    return renderList(splitLines(raw), options.render.bullets_item_template, options.render.bullets_separator);
  }
  return raw;
}

export function collectNodeSectionSlots(node: GenerationNode, ctx: ExecutionContext): Record<string, string> {
  const bindings = node.inputs ?? {};
  const out: Record<string, string> = {};
  for (const [section, slot] of Object.entries(bindings)) {
    const key = section.trim();
    const source = slot.trim();
    if (!key || !source || !ctx.has(source)) {
      continue;
    }
    out[key] = ctx.get(source);
  }
  return out;
}

export function parseJudgeIssues(text: string, ignoreMessages: string[], allowedSections: string[]) {
  const ignored = new Set(ignoreMessages.map((v) => normalizeText(v).toLowerCase()));
  const allowed = new Set(allowedSections.map((v) => v.trim().toLowerCase()).filter(Boolean));
  const normalized = normalizeText(text);
  if (normalized.toUpperCase() === "OK") {
    return [] as Array<{ section: string; message: string }>;
  }
  const out: Array<{ section: string; message: string }> = [];
  for (const line of normalized.split("\n").map((v) => v.trim()).filter(Boolean)) {
    const matched = /^-?\s*\[([a-zA-Z0-9_]+)\]\s*(.+)$/i.exec(line);
    if (!matched) {
      continue;
    }
    const section = matched[1].trim().toLowerCase();
    const message = matched[2].trim();
    if (!allowed.has(section)) {
      continue;
    }
    if (ignored.has(normalizeText(message).toLowerCase())) {
      continue;
    }
    out.push({ section, message });
  }
  return out;
}

export function buildRenderVariables(
  node: GenerationNode,
  ctx: ExecutionContext,
  options: RenderVariablesOptions
): Record<string, string> {
  const vars = ctx.snapshot();
  const bindings = node.inputs ?? {};
  for (const [variable, slot] of Object.entries(bindings)) {
    const key = variable.trim();
    const source = slot.trim();
    if (!key || !source || !ctx.has(source)) {
      continue;
    }
    vars[key] = formatSlotValue(source, ctx.get(source), options);
  }
  return vars;
}
