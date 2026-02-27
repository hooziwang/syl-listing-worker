import { join } from "node:path";
import type { ModelSettings } from "@openai/agents";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { ListingResult } from "../domain/types.js";
import { LLMClient } from "./llm-client.js";
import { parseRequirements, type ListingRequirements } from "./requirements-parser.js";
import { loadTenantRules, type SectionRule, type TenantRules } from "./rules-loader.js";
import type { RedisTraceStore } from "../store/trace-store.js";

interface GenerationInput {
  jobId: string;
  tenantId: string;
  rulesVersion: string;
  inputMarkdown: string;
}

type ENSectionKey = "title" | "bullets" | "description" | "search_terms";

interface JudgeIssue {
  section: ENSectionKey;
  message: string;
}

interface SectionGenerateOptions {
  initialFeedback?: string;
  maxRetries?: number;
  jsonOutput?: boolean;
  writerModelSettings?: Partial<ModelSettings>;
  repairModelSettings?: Partial<ModelSettings>;
  adaptContent?: (raw: string) => { content: string; error?: string };
}

const lineLengthErrorPattern = /^第(\d+)条长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;
const textLengthErrorPattern = /^长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;
const paragraphCountErrorPattern = /^段落数量不满足约束:\s*(\d+)（规则区间 (.+)）$/;

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

function normalizeLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
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

function extractJSONObjectText(input: string): string {
  const text = normalizeText(input);
  if (!text) {
    return "";
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  return text;
}

function adaptJSONArrayContent(raw: string, field: string): { content: string; error?: string } {
  const jsonText = extractJSONObjectText(raw);
  if (!jsonText) {
    return { content: "", error: "JSON 解析失败: 返回为空" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: "", error: `JSON 解析失败: ${msg}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { content: "", error: "JSON 解析失败: 顶层必须是对象" };
  }
  const arr = (parsed as Record<string, unknown>)[field];
  if (!Array.isArray(arr)) {
    return { content: "", error: `JSON 解析失败: 缺少 ${field} 数组字段` };
  }
  const lines = arr.flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }
    return item
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => normalizeLine(stripBulletPrefix(line)))
      .filter(Boolean);
  });
  if (lines.length === 0) {
    return { content: "", error: `JSON 解析失败: ${field} 数组为空` };
  }
  return { content: lines.join("\n") };
}

function dedupeKeepOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = normalizeLine(raw);
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function getNumber(constraints: Record<string, unknown>, key: string, fallback = 0): number {
  const value = constraints[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getTolerance(constraints: Record<string, unknown>): number {
  return getNumber(constraints, "tolerance_chars", 0);
}

function rangeCheck(value: number, min: number, max: number): boolean {
  if (min > 0 && value < min) {
    return false;
  }
  if (max > 0 && value > max) {
    return false;
  }
  return true;
}

function formatRange(min: number, max: number): string {
  if (min > 0 && max > 0) {
    return `[${min},${max}]`;
  }
  if (min > 0) {
    return `[${min},∞)`;
  }
  if (max > 0) {
    return `(-∞,${max}]`;
  }
  return "无限制";
}

function validateSectionContent(content: string, requirements: ListingRequirements, rule: SectionRule): string[] {
  const constraints = rule.constraints;
  const tolerance = getTolerance(constraints);
  const normalized = normalizeText(content);
  const errors: string[] = [];
  const rawMinChars = getNumber(constraints, "min_chars", 0);
  const rawMaxChars = getNumber(constraints, "max_chars", 0);
  const minChars = rawMinChars > 0 ? rawMinChars - tolerance : 0;
  const maxChars = rawMaxChars > 0 ? rawMaxChars + tolerance : 0;
  const hasTextLengthConstraint = rawMinChars > 0 || rawMaxChars > 0;
  if (hasTextLengthConstraint && !rangeCheck(normalized.length, Math.max(0, minChars), maxChars)) {
    errors.push(
      `长度不满足约束: ${normalized.length}（规则区间 ${formatRange(rawMinChars, rawMaxChars)}，容差区间 ${formatRange(Math.max(0, minChars), maxChars)}）`
    );
  }

  const lines = splitLines(content);
  const expectedCount = getNumber(constraints, "line_count", 0);
  const rawMinCharsPerLine = getNumber(constraints, "min_chars_per_line", 0);
  const rawMaxCharsPerLine = getNumber(constraints, "max_chars_per_line", 0);
  const minCharsPerLine = rawMinCharsPerLine > 0 ? rawMinCharsPerLine - tolerance : 0;
  const maxCharsPerLine = rawMaxCharsPerLine > 0 ? rawMaxCharsPerLine + tolerance : 0;
  const hasLineConstraint = expectedCount > 0 || rawMinCharsPerLine > 0 || rawMaxCharsPerLine > 0;
  if (hasLineConstraint) {
    if (expectedCount > 0 && lines.length != expectedCount) {
      errors.push(`行数不满足约束: ${lines.length}（要求 ${expectedCount}）`);
      return errors;
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = normalizeLine(lines[i]);
      const ok = rangeCheck(line.length, Math.max(0, minCharsPerLine), maxCharsPerLine);
      if (!ok) {
        errors.push(
          `第${i + 1}条长度不满足约束: ${line.length}（规则区间 ${formatRange(rawMinCharsPerLine, rawMaxCharsPerLine)}，容差区间 ${formatRange(Math.max(0, minCharsPerLine), maxCharsPerLine)}）`
        );
      }
    }
  }

  const minParagraphs = getNumber(constraints, "min_paragraphs", 0);
  const maxParagraphs = getNumber(constraints, "max_paragraphs", 0);
  if (minParagraphs > 0 || maxParagraphs > 0) {
    const paragraphs = normalized
      .split(/\n\s*\n/g)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!rangeCheck(paragraphs.length, minParagraphs, maxParagraphs)) {
      errors.push(`段落数量不满足约束: ${paragraphs.length}（规则区间 ${formatRange(minParagraphs, maxParagraphs)}）`);
    }
  }

  const mustContain = constraints.must_contain;
  if (Array.isArray(mustContain)) {
    const lc = normalizeLine(content).toLowerCase();
    if (mustContain.includes("brand") && requirements.brand && !lc.includes(requirements.brand.toLowerCase())) {
      errors.push(`缺少品牌词: ${requirements.brand}`);
    }
    if (mustContain.includes("top_keywords")) {
      const topN = Math.min(3, requirements.keywords.length);
      for (let i = 0; i < topN; i += 1) {
        const kw = requirements.keywords[i];
        if (kw && !lc.includes(kw.toLowerCase())) {
          errors.push(`缺少关键词 #${i + 1}: ${kw}`);
        }
      }
    }
  }

  return errors;
}

function extractLineErrorIndex(error: string): number | null {
  const matched = /^第(\d+)条/.exec(error.trim());
  if (!matched) {
    return null;
  }
  const index = Number.parseInt(matched[1], 10);
  if (!Number.isFinite(index) || index <= 0) {
    return null;
  }
  return index - 1;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function buildSearchTermsFromRule(requirements: ListingRequirements, rule: SectionRule): string {
  const source = typeof rule.constraints.source === "string" ? rule.constraints.source : "keywords_copy";
  if (source !== "keywords_copy") {
    throw new Error(`search_terms 暂不支持 source=${source}`);
  }
  const dedupe = rule.constraints.dedupe !== false;
  const separator = typeof rule.constraints.separator === "string" && rule.constraints.separator !== ""
    ? rule.constraints.separator
    : " ";
  const values = dedupe ? dedupeKeepOrder(requirements.keywords) : requirements.keywords.map((v) => normalizeLine(v)).filter(Boolean);
  return values.join(separator);
}

function renderByVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}

function renderList(items: string[], itemTemplate: string, separator = "\n"): string {
  const rendered = items.map((item, index) =>
    renderByVars(itemTemplate, {
      index: String(index + 1),
      item
    })
  );
  return rendered.join(separator);
}

function compactErrorForLLM(error: string): string {
  const text = normalizeLine(error);
  if (!text) {
    return "规则不满足";
  }
  const lineMatched = lineLengthErrorPattern.exec(text);
  if (lineMatched) {
    const [, lineNo, actual, , , tolMin, tolMax] = lineMatched;
    return `第${lineNo}条长度不合规：当前${actual}，目标[${tolMin},${tolMax}]`;
  }
  const lengthMatched = textLengthErrorPattern.exec(text);
  if (lengthMatched) {
    const [, actual, , , tolMin, tolMax] = lengthMatched;
    return `长度不合规：当前${actual}，目标[${tolMin},${tolMax}]`;
  }
  const paragraphMatched = paragraphCountErrorPattern.exec(text);
  if (paragraphMatched) {
    const [, actual, range] = paragraphMatched;
    return `段落数量不合规：当前${actual}，目标${range}`;
  }
  return text;
}

function compactErrorsForLLM(errors: string[], maxItems = 6): string[] {
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  const out = errors
    .map((error) => compactErrorForLLM(error))
    .filter(Boolean)
    .slice(0, Math.max(1, maxItems));
  return out;
}

function truncateByWord(input: string, maxChars: number): string {
  if (maxChars <= 0) {
    return input;
  }
  const text = input.trim();
  if (text.length <= maxChars) {
    return text;
  }
  let out = text.slice(0, maxChars).trim();
  const cut = out.lastIndexOf(" ");
  if (cut >= Math.floor(maxChars * 0.6)) {
    out = out.slice(0, cut).trim();
  }
  return out;
}

function compactLineToMaxChars(line: string, maxChars: number): string {
  const text = normalizeLine(line);
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const colonIdx = text.indexOf(":");
  if (colonIdx > 0) {
    const title = text.slice(0, colonIdx + 1).trim();
    const body = text.slice(colonIdx + 1).trim();
    if (title.length + 1 >= maxChars) {
      return truncateByWord(text, maxChars);
    }
    const remain = maxChars - title.length - 1;
    return `${title} ${truncateByWord(body, remain)}`.trim();
  }
  return truncateByWord(text, maxChars);
}

function compactTextToMaxChars(content: string, maxChars: number): string {
  const text = normalizeText(content);
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return truncateByWord(text, maxChars);
}

function maybeAutoShrinkContent(content: string, rule: SectionRule): string {
  const enabled = rule.constraints.auto_shrink_to_tolerance_max === true;
  if (!enabled) {
    return content;
  }
  const tolerance = getTolerance(rule.constraints);
  const rawMaxPerLine = getNumber(rule.constraints, "max_chars_per_line", 0);
  const maxPerLine = rawMaxPerLine > 0 ? rawMaxPerLine + tolerance : 0;
  const rawMaxChars = getNumber(rule.constraints, "max_chars", 0);
  const maxChars = rawMaxChars > 0 ? rawMaxChars + tolerance : 0;

  let out = normalizeText(content);
  if (maxPerLine > 0) {
    const lines = splitLines(out).map((line) => compactLineToMaxChars(line, maxPerLine));
    out = lines.join("\n");
  }
  if (maxChars > 0) {
    out = compactTextToMaxChars(out, maxChars);
  }
  return normalizeText(out);
}

function adaptSingleLineRepair(raw: string, rule: SectionRule, targetIndex: number): string {
  const trimmed = normalizeText(raw);
  if (!trimmed) {
    return "";
  }
  if (rule.output.format === "json") {
    const field = rule.output.json_array_field || "bullets";
    const adapted = adaptJSONArrayContent(trimmed, field);
    if (!adapted.error) {
      const lines = splitLines(adapted.content);
      if (targetIndex >= 0 && targetIndex < lines.length) {
        return lines[targetIndex];
      }
      if (lines.length > 0) {
        return lines[0];
      }
    }
  }
  const first = trimmed
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizeLine(stripBulletPrefix(line)))
    .find(Boolean);
  return first ?? "";
}

async function promiseValue<T>(promise: Promise<T>, label: string): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}失败: ${msg}`);
  }
}

export class GenerationService {
  private readonly llmClient: LLMClient;
  private executionBrief = "";
  private currentRules: TenantRules | null = null;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
    private readonly traceStore: RedisTraceStore,
    private readonly traceContext: { tenantId: string; jobId: string }
  ) {
    this.llmClient = new LLMClient(env, logger, traceStore, traceContext);
  }

  private baseDisplayLabel(token: string): string {
    const rules = this.currentRules;
    if (!rules) {
      return "";
    }
    const key = token.trim();
    if (!key) {
      return "";
    }
    const mapped = rules.workflow.display_labels[key];
    if (typeof mapped === "string" && mapped.trim() !== "") {
      return mapped.trim();
    }
    const sectionRule = rules.sections.get(key);
    if (sectionRule) {
      const sectionMapped = rules.workflow.display_labels[sectionRule.section];
      if (typeof sectionMapped === "string" && sectionMapped.trim() !== "") {
        return sectionMapped.trim();
      }
    }
    return "";
  }

  private resolveDisplayLabel(payload: Record<string, unknown> | undefined): string {
    if (!payload) {
      return "";
    }
    const exists = typeof payload.label === "string" ? payload.label.trim() : "";
    if (exists) {
      return exists;
    }
    const step = typeof payload.step === "string" ? payload.step.trim() : "";
    const section = typeof payload.section === "string" ? payload.section.trim() : "";

    if (step) {
      const direct = this.baseDisplayLabel(step);
      if (direct) {
        return direct;
      }
      if (step.startsWith("translate_")) {
        return this.baseDisplayLabel(step.slice("translate_".length));
      }
      const roundMatched = /^(.+)_judge_repair_round_(\d+)$/.exec(step);
      if (roundMatched) {
        return this.baseDisplayLabel(roundMatched[1]);
      }
      if (step.endsWith("_whole_repair")) {
        return this.baseDisplayLabel(step.slice(0, -"_whole_repair".length));
      }
      const attemptIdx = step.indexOf("_attempt_");
      if (attemptIdx > 0) {
        return this.baseDisplayLabel(step.slice(0, attemptIdx));
      }
    }

    if (section) {
      return this.baseDisplayLabel(section);
    }
    return "";
  }

  private async appendTrace(
    event: string,
    level: "info" | "warn" | "error" = "info",
    payload?: Record<string, unknown>
  ): Promise<void> {
    const payloadWithLabel = (() => {
      const label = this.resolveDisplayLabel(payload);
      if (!label) {
        return payload;
      }
      return {
        ...(payload ?? {}),
        label
      };
    })();
    try {
      await this.traceStore.append({
        ts: new Date().toISOString(),
        source: "generation",
        event,
        level,
        tenant_id: this.traceContext.tenantId,
        job_id: this.traceContext.jobId,
        payload: payloadWithLabel
      });
    } catch (error) {
      this.logger.warn(
        {
          event: "trace_append_failed",
          trace_event: event,
          error: error instanceof Error ? error.message : String(error)
        },
        "trace append failed"
      );
    }
  }

  private mustRulesLoaded(): TenantRules {
    if (!this.currentRules) {
      throw new Error("规则未加载");
    }
    return this.currentRules;
  }

  private buildSectionSystemPrompt(rule: SectionRule, jsonOutput = false): string {
    const constraintsSummary = this.constraintsSummary(rule);
    const constraintsJSON = JSON.stringify(rule.constraints, null, 2);
    return [
      "你是专业亚马逊 Listing 文案专家。",
      jsonOutput
        ? "只输出符合要求的 JSON 对象，不要解释，不要代码块，不要额外文本。"
        : "只输出目标 section 的文本，不要输出解释、JSON、代码块、前后缀。",
      `section=${rule.section}`,
      `规则:\n${rule.instruction}`,
      `硬性约束摘要:\n${constraintsSummary}`,
      `硬性约束(JSON):\n${constraintsJSON}`
    ].join("\n");
  }

  private buildSectionUserPrompt(requirements: ListingRequirements, section: string, extra?: string): string {
    const keywords = requirements.keywords.join("\n");
    return [
      `任务: 生成 section=${section}（英文）`,
      this.executionBrief ? `执行简报:\n${this.executionBrief}` : "",
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${keywords}`,
      "输入需求原文:",
      requirements.raw,
      extra ? `\n修正反馈:\n${extra}` : ""
    ].join("\n");
  }

  private supportsItemRepair(rule: SectionRule): boolean {
    return rule.execution.repair_mode === "item";
  }

  private supportsLineTargetRepair(rule: SectionRule): boolean {
    const expectedCount = getNumber(rule.constraints, "line_count", 0);
    const minPerLine = getNumber(rule.constraints, "min_chars_per_line", 0);
    const maxPerLine = getNumber(rule.constraints, "max_chars_per_line", 0);
    return expectedCount > 0 || minPerLine > 0 || maxPerLine > 0;
  }

  private shouldTryItemRepair(rule: SectionRule, errors: string[]): boolean {
    if (!this.supportsLineTargetRepair(rule)) {
      return false;
    }
    if (this.supportsItemRepair(rule)) {
      return true;
    }
    return errors.some((error) => extractLineErrorIndex(error) !== null);
  }

  private lineCharRangeText(rule: SectionRule): string {
    const tolerance = getTolerance(rule.constraints);
    const minChars = Math.max(0, getNumber(rule.constraints, "min_chars_per_line", 0) - tolerance);
    const maxChars = getNumber(rule.constraints, "max_chars_per_line", 0) + tolerance;
    if (minChars > 0 && maxChars > 0) {
      return `[${minChars}, ${maxChars}]`;
    }
    if (minChars > 0) {
      return `>= ${minChars}`;
    }
    if (maxChars > 0) {
      return `<= ${maxChars}`;
    }
    return "遵循规则";
  }

  private constraintsSummary(rule: SectionRule): string {
    const constraints = rule.constraints;
    const tolerance = getTolerance(constraints);
    const lines: string[] = [];
    const lineCount = getNumber(constraints, "line_count", 0);
    const rawMinPerLine = getNumber(constraints, "min_chars_per_line", 0);
    const rawMaxPerLine = getNumber(constraints, "max_chars_per_line", 0);
    const rawMinChars = getNumber(constraints, "min_chars", 0);
    const rawMaxChars = getNumber(constraints, "max_chars", 0);
    const minParagraphs = getNumber(constraints, "min_paragraphs", 0);
    const maxParagraphs = getNumber(constraints, "max_paragraphs", 0);

    if (lineCount > 0) {
      lines.push(`- 行数必须=${lineCount}`);
    }
    if (rawMinPerLine > 0 || rawMaxPerLine > 0) {
      const tolMin = rawMinPerLine > 0 ? Math.max(0, rawMinPerLine - tolerance) : 0;
      const tolMax = rawMaxPerLine > 0 ? rawMaxPerLine + tolerance : 0;
      lines.push(`- 每行长度：规则${formatRange(rawMinPerLine, rawMaxPerLine)}，容差${formatRange(tolMin, tolMax)}`);
    }
    if (rawMinChars > 0 || rawMaxChars > 0) {
      const tolMin = rawMinChars > 0 ? Math.max(0, rawMinChars - tolerance) : 0;
      const tolMax = rawMaxChars > 0 ? rawMaxChars + tolerance : 0;
      lines.push(`- 总长度：规则${formatRange(rawMinChars, rawMaxChars)}，容差${formatRange(tolMin, tolMax)}`);
    }
    if (minParagraphs > 0 || maxParagraphs > 0) {
      lines.push(`- 段落数：${formatRange(minParagraphs, maxParagraphs)}`);
    }
    const mustContain = constraints.must_contain;
    if (Array.isArray(mustContain) && mustContain.length > 0) {
      lines.push(`- 必含项：${mustContain.join(", ")}`);
    }
    const source = typeof constraints.source === "string" ? constraints.source : "";
    if (source) {
      lines.push(`- 数据来源：${source}`);
    }
    return lines.length > 0 ? lines.join("\n") : "- 无额外约束";
  }

  private deepseekJSONModeSettings(): Partial<ModelSettings> | undefined {
    if (this.env.generationProvider !== "deepseek") {
      return undefined;
    }
    return {
      providerData: {
        response_format: {
          type: "json_object"
        }
      }
    };
  }

  private buildItemRepairSystemPrompt(rule: SectionRule, targetIndex: number): string {
    const constraintsSummary = this.constraintsSummary(rule);
    return [
      "你是专业亚马逊 Listing 文案专家。",
      "你正在修复单条文案。",
      "只输出修复后的单行英文文本，不要编号，不要项目符号，不要解释，不要换行。",
      "若规则中包含 JSON/数组/整段输出格式要求，在本步骤全部忽略，仅按单条文本修复。",
      `section=${rule.section}`,
      `target_line=${targetIndex + 1}`,
      `line_length=${this.lineCharRangeText(rule)}`,
      `内容规则:\n${rule.instruction}`,
      `硬性约束摘要:\n${constraintsSummary}`
    ].join("\n");
  }

  private buildItemRepairUserPrompt(
    requirements: ListingRequirements,
    rule: SectionRule,
    lines: string[],
    targetIndex: number,
    lineErrors: string[]
  ): string {
    const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
    return [
      `任务: 修复 section=${rule.section} 的第 ${targetIndex + 1} 行（英文）`,
      this.executionBrief ? `执行简报:\n${this.executionBrief}` : "",
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${requirements.keywords.join("\n")}`,
      `当前 ${rule.section} 全部行:\n${numbered}`,
      `需要修复的行:\n${targetIndex + 1}. ${lines[targetIndex] ?? ""}`,
      lineErrors.length > 0 ? `该行校验错误:\n${compactErrorsForLLM(lineErrors).map((v) => `- ${v}`).join("\n")}` : "",
      "只返回修复后的这一行英文文本。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async tryItemRepair(
    requirements: ListingRequirements,
    rule: SectionRule,
    step: string,
    content: string,
    validate: (content: string) => string[],
    initialErrors: string[]
  ): Promise<{ ok: true; content: string } | { ok: false; errors: string[] }> {
    const expectedCount = getNumber(rule.constraints, "line_count", 0);
    let lines = splitLines(content);
    if (expectedCount > 0 && lines.length !== expectedCount) {
      return { ok: false, errors: initialErrors };
    }

    const rounds = Math.max(1, getNumber(rule.constraints, "item_repair_rounds", 2));
    const apiAttempts = Math.max(2, getNumber(rule.constraints, "api_attempts", 4));
    let currentErrors = initialErrors;

    for (let round = 1; round <= rounds; round += 1) {
      const targets = uniqueSorted(
        currentErrors
          .map((err) => extractLineErrorIndex(err))
          .filter((idx): idx is number => idx !== null && idx >= 0 && idx < lines.length)
      );
      if (targets.length === 0) {
        return { ok: false, errors: currentErrors };
      }

      await this.appendTrace("section_item_repair_start", "info", {
        step,
        section: rule.section,
        round,
        targets: targets.map((v) => v + 1),
        errors: currentErrors
      });
      this.logger.info(
        {
          event: "section_item_repair_start",
          step,
          section: rule.section,
          round,
          targets: targets.map((v) => v + 1),
          errors: currentErrors
        },
        "section item repair start"
      );

      for (const idx of targets) {
        const lineErrors = currentErrors.filter((err) => extractLineErrorIndex(err) === idx);
        const repaired = await this.llmClient.repairWithRepairAgent(
          this.buildItemRepairSystemPrompt(rule, idx),
          this.buildItemRepairUserPrompt(requirements, rule, lines, idx, lineErrors),
          `${step}_item_${idx + 1}_round_${round}`,
          apiAttempts
        );
        const adaptedLine = adaptSingleLineRepair(repaired, rule, idx);
        const normalizedLine = normalizeLine(stripBulletPrefix(adaptedLine));
        const maxChars = (() => {
          const rawMax = getNumber(rule.constraints, "max_chars_per_line", 0);
          if (rawMax <= 0) {
            return 0;
          }
          return rawMax + getTolerance(rule.constraints);
        })();
        lines[idx] = maxChars > 0 ? compactLineToMaxChars(normalizedLine, maxChars) : normalizedLine;
      }

      const merged = maybeAutoShrinkContent(lines.join("\n"), rule);
      currentErrors = validate(merged);
      if (currentErrors.length === 0) {
        await this.appendTrace("section_item_repair_ok", "info", {
          step,
          section: rule.section,
          round,
          output_chars: merged.length
        });
        this.logger.info(
          {
            event: "section_item_repair_ok",
            step,
            section: rule.section,
            round,
            output_chars: merged.length
          },
          "section item repair ok"
        );
        return { ok: true, content: merged };
      }

      await this.appendTrace("section_item_repair_validate_fail", "warn", {
        step,
        section: rule.section,
        round,
        errors: currentErrors
      });
      this.logger.warn(
        {
          event: "section_item_repair_validate_fail",
          step,
          section: rule.section,
          round,
          errors: currentErrors
        },
        "section item repair validation failed"
      );
    }

    return { ok: false, errors: currentErrors };
  }

  private buildWholeRepairSystemPrompt(rule: SectionRule, jsonOutput = false): string {
    return [
      "你是专业亚马逊 Listing 文案专家。",
      "你正在修复一段已有文案。",
      jsonOutput
        ? "只输出修复后的 JSON 对象，不要解释，不要代码块，不要额外文本。"
        : "只输出修复后的 section 文本，不要解释，不要 JSON，不要代码块。",
      `section=${rule.section}`,
      `规则:\n${rule.instruction}`
    ].join("\n");
  }

  private buildWholeRepairUserPrompt(
    requirements: ListingRequirements,
    rule: SectionRule,
    content: string,
    errors: string[],
    jsonOutput = false
  ): string {
    const constraintsText = JSON.stringify(rule.constraints, null, 2);
    return [
      `任务: 修复 section=${rule.section}（英文）`,
      this.executionBrief ? `执行简报:\n${this.executionBrief}` : "",
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${requirements.keywords.join("\n")}`,
      `当前文案:\n${content}`,
      `校验错误:\n${compactErrorsForLLM(errors).map((v) => `- ${v}`).join("\n")}`,
      `约束(JSON):\n${constraintsText}`,
      jsonOutput
        ? "请重写内容并一次性满足约束。只输出修复后的 JSON 对象。"
        : "请重写整段内容，必须一次性满足约束。只输出修复后正文。"
    ].join("\n");
  }

  private async tryWholeRepair(
    requirements: ListingRequirements,
    rule: SectionRule,
    step: string,
    content: string,
    validate: (content: string) => string[],
    currentErrors: string[],
    options?: {
      jsonOutput?: boolean;
      repairModelSettings?: Partial<ModelSettings>;
      adaptContent?: (raw: string) => { content: string; error?: string };
    }
  ): Promise<{ ok: true; content: string } | { ok: false; errors: string[] }> {
    const apiAttempts = Math.max(2, getNumber(rule.constraints, "api_attempts", 4));
    await this.appendTrace("section_whole_repair_start", "info", {
      step,
      section: rule.section,
      errors: currentErrors
    });
    this.logger.info(
      {
        event: "section_whole_repair_start",
        step,
        section: rule.section,
        errors: currentErrors
      },
      "section whole repair start"
    );

    const repaired = await this.llmClient.repairWithRepairAgent(
      this.buildWholeRepairSystemPrompt(rule, options?.jsonOutput ?? false),
      this.buildWholeRepairUserPrompt(requirements, rule, content, currentErrors, options?.jsonOutput ?? false),
      `${step}_whole_repair`,
      apiAttempts,
      options?.repairModelSettings
    );
    const adapted = options?.adaptContent ? options.adaptContent(repaired) : { content: repaired };
    const normalized = maybeAutoShrinkContent(normalizeText(adapted.content), rule);
    const repairedErrors = adapted.error ? [adapted.error] : validate(normalized);
    if (repairedErrors.length === 0) {
      await this.appendTrace("section_whole_repair_ok", "info", {
        step,
        section: rule.section,
        output_chars: normalized.length
      });
      this.logger.info(
        {
          event: "section_whole_repair_ok",
          step,
          section: rule.section,
          output_chars: normalized.length
        },
        "section whole repair ok"
      );
      return { ok: true, content: normalized };
    }

    await this.appendTrace("section_whole_repair_validate_fail", "warn", {
      step,
      section: rule.section,
      errors: repairedErrors
    });
    this.logger.warn(
      {
        event: "section_whole_repair_validate_fail",
        step,
        section: rule.section,
        errors: repairedErrors
      },
      "section whole repair validation failed"
    );
    return { ok: false, errors: repairedErrors };
  }

  private async generateSectionWithValidation(
    requirements: ListingRequirements,
    rule: SectionRule,
    step: string,
    validate: (content: string) => string[],
    options?: SectionGenerateOptions
  ): Promise<string> {
    const retries = Math.max(1, options?.maxRetries ?? rule.execution.retries ?? 3);
    const apiAttempts = Math.max(2, getNumber(rule.constraints, "api_attempts", 4));
    let feedback = options?.initialFeedback?.trim() ?? "";

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const started = Date.now();
      await this.appendTrace("section_generate_start", "info", {
        step,
        section: rule.section,
        attempt,
        max_attempts: retries
      });
      this.logger.info(
        { event: "section_generate_start", step, section: rule.section, attempt, max_attempts: retries },
        "section generate start"
      );
      const content = await this.llmClient.writeWithWriterAgent(
        this.buildSectionSystemPrompt(rule, options?.jsonOutput ?? false),
        this.buildSectionUserPrompt(requirements, rule.section, feedback),
        `${step}_attempt_${attempt}`,
        apiAttempts,
        options?.writerModelSettings
      );

      const adapted = options?.adaptContent ? options.adaptContent(content) : { content };
      const normalized = maybeAutoShrinkContent(normalizeText(adapted.content), rule);
      let errors = adapted.error ? [adapted.error] : validate(normalized);
      if (errors.length === 0) {
        await this.appendTrace("section_generate_ok", "info", {
          step,
          section: rule.section,
          attempt,
          duration_ms: Date.now() - started,
          output_chars: normalized.length
        });
        this.logger.info(
          {
            event: "section_generate_ok",
            step,
            section: rule.section,
            attempt,
            duration_ms: Date.now() - started,
            output_chars: normalized.length
          },
          "section generate ok"
        );
        return normalized;
      }

      const itemRepairEnabled = this.shouldTryItemRepair(rule, errors);
      if (itemRepairEnabled) {
        await this.appendTrace("section_repair_needed", "warn", {
          step,
          section: rule.section,
          repair_mode: this.supportsItemRepair(rule) ? "item" : "item_fallback",
          errors
        });
        this.logger.warn(
          {
            event: "section_repair_needed",
            step,
            section: rule.section,
            repair_mode: this.supportsItemRepair(rule) ? "item" : "item_fallback",
            errors
          },
          "section repair needed"
        );
        const repaired = await this.tryItemRepair(
          requirements,
          rule,
          step,
          normalized,
          validate,
          errors
        );
        if (repaired.ok) {
          return repaired.content;
        }
        errors = repaired.errors;
      }

      if (rule.execution.repair_mode !== "item") {
        await this.appendTrace("section_repair_needed", "warn", {
          step,
          section: rule.section,
          repair_mode: "whole",
          errors
        });
        this.logger.warn(
          {
            event: "section_repair_needed",
            step,
            section: rule.section,
            repair_mode: "whole",
            errors
          },
          "section repair needed"
        );
        const wholeRepaired = await this.tryWholeRepair(
          requirements,
          rule,
          step,
          normalized,
          validate,
          errors,
          {
            jsonOutput: options?.jsonOutput,
            repairModelSettings: options?.repairModelSettings,
            adaptContent: options?.adaptContent
          }
        );
        if (wholeRepaired.ok) {
          return wholeRepaired.content;
        }
        errors = wholeRepaired.errors;
      }

      feedback = compactErrorsForLLM(errors, 8).map((err) => `- ${err}`).join("\n");
      await this.appendTrace("validate_fail", "warn", {
        step,
        section: rule.section,
        attempt,
        errors
      });
      this.logger.warn(
        { event: "validate_fail", step, attempt, errors },
        "validation failed"
      );

      if (attempt >= retries) {
        await this.appendTrace("section_generate_failed", "error", {
          step,
          section: rule.section,
          attempt,
          errors
        });
        throw new Error(`${step} 重试后仍失败: ${errors.join("; ")}`);
      }
    }

    throw new Error(`${step} 未生成有效内容`);
  }

  private groupJudgeIssuesBySection(issues: JudgeIssue[]): Record<ENSectionKey, string[]> {
    const grouped: Record<ENSectionKey, string[]> = {
      title: [],
      bullets: [],
      description: [],
      search_terms: []
    };
    for (const issue of issues) {
      grouped[issue.section].push(issue.message);
    }
    return grouped;
  }

  private buildJudgeFeedbackText(messages: string[]): string {
    return messages.map((message) => `- ${message}`).join("\n");
  }

  private async translateText(text: string, step: string, retries: number): Promise<string> {
    const rules = this.mustRulesLoaded();
    const started = Date.now();
    await this.appendTrace("translate_start", "info", { step, input_chars: text.length, retries });
    this.logger.info({ event: "translate_start", step, input_chars: text.length, retries }, "translate start");
    const translated = await this.llmClient.translateWithTranslatorAgent(
      rules.workflow.translation.system_prompt,
      text,
      step,
      Math.max(1, retries)
    );
    this.logger.info(
      { event: "translate_ok", step, duration_ms: Date.now() - started, output_chars: translated.length },
      "translate ok"
    );
    await this.appendTrace("translate_ok", "info", {
      step,
      duration_ms: Date.now() - started,
      output_chars: translated.length
    });
    return translated;
  }

  private buildPromptVars(
    requirements: ListingRequirements,
    sections?: Partial<Record<ENSectionKey, string>>
  ): Record<string, string> {
    return {
      brand: requirements.brand,
      category: requirements.category,
      keywords: requirements.keywords.join("\n"),
      requirements_raw: requirements.raw,
      title: sections?.title ?? "",
      bullets: sections?.bullets ?? "",
      description: sections?.description ?? "",
      search_terms: sections?.search_terms ?? ""
    };
  }

  private async planExecution(requirements: ListingRequirements): Promise<string> {
    const rules = this.mustRulesLoaded();
    if (!rules.workflow.planning.enabled) {
      return "";
    }
    const started = Date.now();
    await this.appendTrace("planning_start", "info", {
      brand: requirements.brand,
      category: requirements.category,
      keywords_count: requirements.keywords.length
    });
    try {
      const brief = await this.llmClient.orchestrateWithOrchestratorAgent(
        rules.workflow.planning.system_prompt,
        renderByVars(rules.workflow.planning.user_prompt, this.buildPromptVars(requirements)),
        "orchestration",
        rules.workflow.planning.retries
      );
      const normalized = normalizeText(brief);
      await this.appendTrace("planning_ok", "info", {
        duration_ms: Date.now() - started,
        output_chars: normalized.length
      });
      return normalized;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.appendTrace("planning_failed", "warn", {
        duration_ms: Date.now() - started,
        error: msg
      });
      this.logger.warn({ event: "planning_failed", error: msg }, "planning failed");
      return "";
    }
  }

  private parseJudgeIssues(text: string): JudgeIssue[] {
    const rules = this.mustRulesLoaded();
    const ignored = new Set(rules.workflow.judge.ignore_messages.map((v) => normalizeText(v).toLowerCase()));
    const allowed = new Set(
      rules.requiredSections.filter((v) => v !== "translation") as ENSectionKey[]
    );
    const normalized = normalizeText(text);
    if (normalized.toUpperCase() === "OK") {
      return [];
    }
    const lines = normalized.split("\n").map((v) => v.trim()).filter(Boolean);
    const out: JudgeIssue[] = [];
    for (const line of lines) {
      const m = /^-?\s*\[([a-zA-Z0-9_]+)\]\s*(.+)$/i.exec(line);
      if (!m) {
        continue;
      }
      const section = m[1].toLowerCase() as ENSectionKey;
      if (!allowed.has(section)) {
        continue;
      }
      const message = m[2].trim();
      if (ignored.has(normalizeText(message).toLowerCase())) {
        continue;
      }
      out.push({
        section,
        message
      });
    }
    return out;
  }

  private async runQualityJudge(
    requirements: ListingRequirements,
    sections: Record<ENSectionKey, string>
  ): Promise<JudgeIssue[]> {
    const rules = this.mustRulesLoaded();
    if (!rules.workflow.judge.enabled) {
      return [];
    }
    const started = Date.now();
    await this.appendTrace("quality_judge_start", "info", {});
    try {
      const judgeOutput = await this.llmClient.reviewWithJudgeAgent(
        rules.workflow.judge.system_prompt,
        renderByVars(rules.workflow.judge.user_prompt, this.buildPromptVars(requirements, sections)),
        "quality_judge",
        rules.workflow.judge.retries
      );
      const issues = this.parseJudgeIssues(judgeOutput);
      if (issues.length > 0) {
        await this.appendTrace("quality_judge_issues", "warn", {
          duration_ms: Date.now() - started,
          issues
        });
      } else {
        await this.appendTrace("quality_judge_ok", "info", {
          duration_ms: Date.now() - started
        });
      }
      return issues;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.appendTrace("quality_judge_failed", "warn", {
        duration_ms: Date.now() - started,
        error: msg
      });
      this.logger.warn({ event: "quality_judge_failed", error: msg }, "quality judge failed");
      return [];
    }
  }

  async generate(input: GenerationInput): Promise<ListingResult> {
    const start = Date.now();
    await this.appendTrace("generation_start", "info", {
      tenant_id: input.tenantId,
      job_id: input.jobId,
      rules_version: input.rulesVersion,
      input_chars: input.inputMarkdown.length
    });
    this.logger.info(
      {
        event: "generation_start",
        tenant_id: input.tenantId,
        job_id: input.jobId,
        rules_version: input.rulesVersion,
        input_chars: input.inputMarkdown.length
      },
      "generation start"
    );
    const archivePath = join(this.env.rulesFsDir, input.tenantId, input.rulesVersion, "rules.tar.gz");
    const tenantRules = await loadTenantRules(archivePath, input.tenantId, input.rulesVersion);
    this.currentRules = tenantRules;
    await this.appendTrace("rules_loaded", "info", {
      archive_path: archivePath,
      rules_version: input.rulesVersion
    });

    const requirements = parseRequirements(input.inputMarkdown, tenantRules.input);

    if (!requirements.category) {
      await this.appendTrace("generation_invalid_input", "error", { error: "缺少分类" });
      throw new Error("缺少分类");
    }
    if (requirements.keywords.length < 3) {
      await this.appendTrace("generation_invalid_input", "error", { error: "关键词过少，至少 3 条" });
      throw new Error("关键词过少，至少 3 条");
    }

    const titleRule = tenantRules.sections.get("title");
    const bulletsRule = tenantRules.sections.get("bullets");
    const descriptionRule = tenantRules.sections.get("description");
    const searchTermsRule = tenantRules.sections.get("search_terms");
    const translationRule = tenantRules.sections.get("translation");

    if (!titleRule || !bulletsRule || !descriptionRule || !searchTermsRule || !translationRule) {
      const existsPayload: Record<string, unknown> = {};
      for (const key of tenantRules.requiredSections) {
        existsPayload[key] = tenantRules.sections.has(key);
      }
      await this.appendTrace("rules_missing_sections", "error", existsPayload);
      throw new Error(`规则文件缺失：${tenantRules.requiredSections.join("/")} 必须齐全`);
    }

    const translationRetries = Math.max(1, translationRule.execution.retries || 2);
    this.executionBrief = await this.planExecution(requirements);

    const categoryTranslationPromise = this.translateText(requirements.category, "translate_category", translationRetries);
    const keywordsText = requirements.keywords.join("\n");
    const keywordsTranslationPromise = this.translateText(keywordsText, "translate_keywords", translationRetries);

    const titleEnPromise = this.generateSectionWithValidation(requirements, titleRule, "title", (content) =>
      validateSectionContent(content, requirements, titleRule)
    );
    const bulletsJSONModeSettings = this.deepseekJSONModeSettings();
    const bulletsJSONArrayField = bulletsRule.output.json_array_field || "bullets";
    const bulletsRawPromise = this.generateSectionWithValidation(requirements, bulletsRule, "bullets", (content) => {
      return validateSectionContent(content, requirements, bulletsRule);
    }, {
      jsonOutput: true,
      writerModelSettings: bulletsJSONModeSettings,
      repairModelSettings: bulletsJSONModeSettings,
      adaptContent: (raw) => adaptJSONArrayContent(raw, bulletsJSONArrayField)
    });
    const descriptionEnPromise = this.generateSectionWithValidation(requirements, descriptionRule, "description", (content) =>
      validateSectionContent(content, requirements, descriptionRule)
    );

    let titleEn = await titleEnPromise;
    let bulletsRaw = await bulletsRawPromise;
    let bulletsLinesEn = splitLines(bulletsRaw);
    let descriptionEn = await descriptionEnPromise;

    const searchTermsEn = buildSearchTermsFromRule(requirements, searchTermsRule);

    const judgeSkip = new Set(tenantRules.workflow.judge.skip_sections);
    const maxJudgeRounds = tenantRules.workflow.judge.max_rounds;
    let judgeIssues = await this.runQualityJudge(requirements, {
      title: titleEn,
      bullets: bulletsLinesEn.join("\n"),
      description: descriptionEn,
      search_terms: searchTermsEn
    });

    for (let judgeRound = 1; judgeRound <= maxJudgeRounds && judgeIssues.length > 0; judgeRound += 1) {
      const grouped = this.groupJudgeIssuesBySection(judgeIssues);
      await this.appendTrace("quality_judge_repair_round_start", "warn", {
        round: judgeRound,
        issues_count: judgeIssues.length,
        grouped
      });

      if (grouped.title.length > 0) {
        titleEn = await this.generateSectionWithValidation(
          requirements,
          titleRule,
          `title_judge_repair_round_${judgeRound}`,
          (content) => validateSectionContent(content, requirements, titleRule),
          {
            initialFeedback: this.buildJudgeFeedbackText(grouped.title),
            maxRetries: 2
          }
        );
      }

      if (grouped.bullets.length > 0) {
        bulletsRaw = await this.generateSectionWithValidation(
          requirements,
          bulletsRule,
          `bullets_judge_repair_round_${judgeRound}`,
          (content) => validateSectionContent(content, requirements, bulletsRule),
          {
            initialFeedback: this.buildJudgeFeedbackText(grouped.bullets),
            maxRetries: 2,
            jsonOutput: true,
            writerModelSettings: bulletsJSONModeSettings,
            repairModelSettings: bulletsJSONModeSettings,
            adaptContent: (raw) => adaptJSONArrayContent(raw, bulletsJSONArrayField)
          }
        );
        bulletsLinesEn = splitLines(bulletsRaw);
      }

      if (grouped.description.length > 0) {
        descriptionEn = await this.generateSectionWithValidation(
          requirements,
          descriptionRule,
          `description_judge_repair_round_${judgeRound}`,
          (content) => validateSectionContent(content, requirements, descriptionRule),
          {
            initialFeedback: this.buildJudgeFeedbackText(grouped.description),
            maxRetries: 2
          }
        );
      }

      if (grouped.search_terms.length > 0) {
        const searchTermsSource = typeof searchTermsRule.constraints.source === "string"
          ? searchTermsRule.constraints.source
          : "keywords_copy";
        await this.appendTrace("quality_judge_repair_skip", "warn", {
          round: judgeRound,
          section: "search_terms",
          reason: judgeSkip.has("search_terms")
            ? `search_terms 使用 ${searchTermsSource}，当前不进行模型改写`
            : "当前执行器未启用 search_terms 模型改写",
          issues: grouped.search_terms
        });
      }

      judgeIssues = await this.runQualityJudge(requirements, {
        title: titleEn,
        bullets: bulletsLinesEn.join("\n"),
        description: descriptionEn,
        search_terms: searchTermsEn
      });
    }

    const titleCnPromise = this.translateText(titleEn, "translate_title", translationRetries);
    const bulletsCnPromise = this.translateText(bulletsLinesEn.join("\n"), "translate_bullets", translationRetries);
    const descriptionCnPromise = this.translateText(descriptionEn, "translate_description", translationRetries);
    const searchTermsCnPromise = this.translateText(searchTermsEn, "translate_search_terms", translationRetries);

    const categoryCn = await promiseValue(categoryTranslationPromise, "分类翻译");
    const keywordsCnRaw = await promiseValue(keywordsTranslationPromise, "关键词翻译");
    const titleCn = await promiseValue(titleCnPromise, "标题翻译");
    const bulletsCnRaw = await promiseValue(bulletsCnPromise, "五点翻译");
    const descriptionCn = await promiseValue(descriptionCnPromise, "描述翻译");
    const searchTermsCn = await promiseValue(searchTermsCnPromise, "搜索词翻译");

    const keywordsCn = splitLines(keywordsCnRaw);
    const bulletsCn = splitLines(bulletsCnRaw);

    const keywordsCnFinal = keywordsCn.length > 0 ? keywordsCn : requirements.keywords;
    const bulletsCnFinal = bulletsCn.length > 0 ? bulletsCn : bulletsLinesEn;

    const vars = {
      brand: requirements.brand,
      category_en: requirements.category,
      category_cn: normalizeText(categoryCn),
      keywords_en: renderList(requirements.keywords, tenantRules.workflow.render.keywords_item_template),
      keywords_cn: renderList(keywordsCnFinal, tenantRules.workflow.render.keywords_item_template),
      title_en: normalizeText(titleEn),
      title_cn: normalizeText(titleCn),
      bullets_en: renderList(
        bulletsLinesEn,
        tenantRules.workflow.render.bullets_item_template,
        tenantRules.workflow.render.bullets_separator
      ),
      bullets_cn: renderList(
        bulletsCnFinal,
        tenantRules.workflow.render.bullets_item_template,
        tenantRules.workflow.render.bullets_separator
      ),
      description_en: normalizeText(descriptionEn),
      description_cn: normalizeText(descriptionCn),
      search_terms_en: normalizeText(searchTermsEn),
      search_terms_cn: normalizeText(searchTermsCn)
    };

    const enMarkdown = normalizeText(renderByVars(tenantRules.templates.en, vars));
    const cnMarkdown = normalizeText(renderByVars(tenantRules.templates.cn, vars));

    this.logger.info(
      {
        event: "generation_ok",
        tenant_id: input.tenantId,
        job_id: input.jobId,
        rules_version: input.rulesVersion,
        timing_ms: Date.now() - start,
        en_chars: enMarkdown.length,
        cn_chars: cnMarkdown.length
      },
      "generation ok"
    );
    await this.appendTrace("generation_ok", "info", {
      rules_version: input.rulesVersion,
      timing_ms: Date.now() - start,
      en_chars: enMarkdown.length,
      cn_chars: cnMarkdown.length
    });

    return {
      en_markdown: enMarkdown,
      cn_markdown: cnMarkdown,
      meta: {
        highlight_words_en: dedupeKeepOrder(requirements.keywords),
        highlight_words_cn: dedupeKeepOrder(keywordsCnFinal)
      },
      validation_report: [
        `rules_version=${input.rulesVersion}`,
        `keywords_count=${requirements.keywords.length}`,
        `bullets_count=${bulletsLinesEn.length}`,
        `judge_issues_count=${judgeIssues.length}`
      ],
      timing_ms: Date.now() - start,
      billing_summary: {
        provider: "deepseek",
        model: this.env.deepseekModel,
        note: "english generation + chinese translation"
      }
    };
  }
}
