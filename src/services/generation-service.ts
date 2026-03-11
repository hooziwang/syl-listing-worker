import { basename, extname, join } from "node:path";
import type { ModelSettings } from "@openai/agents";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { ListingResult } from "../domain/types.js";
import { LLMClient } from "./llm-client.js";
import { parseRequirements, type ListingRequirements } from "./requirements-parser.js";
import { loadTenantRules, type SectionRule, type TenantRules } from "./rules-loader.js";
import type { RedisTraceStore } from "../store/trace-store.js";
import { buildWorkflowGraph } from "../workflow/graph.js";
import { ExecutionContext } from "../workflow/execution-context.js";
import { WorkflowEngine } from "../workflow/engine.js";
import type { NodeExecutionResult } from "../workflow/node-executor.js";
import type { WorkflowNode } from "../workflow/types.js";
import { ExecutorRegistry } from "../workflow/registry.js";
import { GenerateNodeExecutor } from "../workflow/executors/generate-node.js";
import { TranslateNodeExecutor } from "../workflow/executors/translate-node.js";
import { JudgeNodeExecutor } from "../workflow/executors/judge-node.js";
import { DeriveNodeExecutor } from "../workflow/executors/derive-node.js";
import { RenderNodeExecutor } from "../workflow/executors/render-node.js";
import { buildRenderVariables, collectNodeSectionSlots, parseJudgeIssues } from "../workflow/bindings.js";

interface GenerationInput {
  jobId: string;
  tenantId: string;
  rulesVersion: string;
  inputMarkdown: string;
  inputFilename?: string;
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

interface JudgeIssue {
  section: string;
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

interface WorkflowExecutionOutput {
  enMarkdown: string;
  cnMarkdown: string;
  bulletsCount: number;
  judgeIssuesCount: number;
}

const lineLengthErrorPattern = /^第(\d+)条长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;
const textLengthErrorPattern = /^长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;
const paragraphCountErrorPattern = /^段落数量不满足约束:\s*(\d+)（规则区间 (.+)）$/;
const trailingClosersPattern = /[)"'\]》】）”’]+$/g;
const trailingPunctPattern = /[.!?。！？;；,:，、]+$/g;
const sentenceEndPattern = /[.!?。！？]$/;
const danglingTailWords = new Set([
  "to",
  "and",
  "or",
  "with",
  "for",
  "in",
  "on",
  "of",
  "from",
  "by",
  "at",
  "as",
  "than",
  "that",
  "which",
  "while",
  "because",
  "if",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "is",
  "are",
  "was",
  "were",
  "be",
  "being",
  "been",
  "can",
  "could",
  "should",
  "would",
  "may",
  "might",
  "must",
  "will",
  "shall"
]);
const promptRawMaxChars = 1800;
const promptRawCutoffMarkers = [
  "竞品",
  "参考文案",
  "对标文案",
  "示例文案",
  "competitor",
  "reference listing",
  "sample listing"
];

interface PromptRawResult {
  text: string;
  originalChars: number;
  finalChars: number;
  cutByMarker: boolean;
  truncated: boolean;
}

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

function normalizeInputFilename(raw: string | undefined): string {
  if (typeof raw !== "string") {
    return "";
  }
  const cleaned = raw.replace(/\r?\n/g, "").trim();
  if (!cleaned) {
    return "";
  }
  const name = basename(cleaned).trim();
  if (!name || name === "." || name === "..") {
    return "";
  }
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length).trim() : name;
  if (!base || base === "." || base === "..") {
    return "";
  }
  return base;
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

function shouldCutoffPromptRawLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return promptRawCutoffMarkers.some((marker) => normalized.includes(marker));
}

function compactRequirementsRawForPrompt(raw: string): PromptRawResult {
  const normalized = normalizeText(raw);
  if (!normalized) {
    return {
      text: "",
      originalChars: 0,
      finalChars: 0,
      cutByMarker: false,
      truncated: false
    };
  }

  const lines = normalized.split("\n");
  const kept: string[] = [];
  let cutByMarker = false;
  let previousBlank = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (shouldCutoffPromptRawLine(trimmed)) {
      cutByMarker = true;
      break;
    }
    if (trimmed === "") {
      if (!previousBlank) {
        kept.push("");
      }
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    kept.push(line);
  }

  const merged = normalizeText(kept.join("\n"));
  let text = merged;
  let truncated = false;
  if (text.length > promptRawMaxChars) {
    truncated = true;
    const sliced = text.slice(0, promptRawMaxChars);
    const cutAt = sliced.lastIndexOf("\n");
    const base = cutAt > 0 ? sliced.slice(0, cutAt) : sliced;
    text = `${base.trim()}\n...(需求原文已截断)`;
  }
  return {
    text,
    originalChars: normalized.length,
    finalChars: text.length,
    cutByMarker,
    truncated
  };
}

function replaceTopHeading(markdown: string, filename: string): string {
  const trimmedName = normalizeInputFilename(filename);
  if (!trimmedName) {
    return normalizeText(markdown);
  }
  const heading = `# ${trimmedName}`;
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("# ")) {
      lines[i] = heading;
      return normalizeText(lines.join("\n"));
    }
    return normalizeText(`${heading}\n\n${normalized}`);
  }
  return heading;
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

type DuplicateKeyword = {
  keyword: string;
  count: number;
};

function duplicateKeywords(values: string[]): DuplicateKeyword[] {
  const counts = new Map<string, DuplicateKeyword>();
  for (const raw of values) {
    const value = normalizeLine(raw);
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    counts.set(key, { keyword: value, count: 1 });
  }
  return [...counts.values()].filter((item) => item.count > 1);
}

function formatDuplicateKeywords(duplicates: DuplicateKeyword[]): string {
  return duplicates.map((item) => `${item.keyword}（${item.count}次）`).join("；");
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

type KeywordEmbeddingConfig = {
  enabled: boolean;
  minTotal: number;
  enforceOrder: boolean;
  exactMatch: boolean;
  noSplit: boolean;
  boldWrapper: boolean;
  slotRetries: number;
};

function readKeywordEmbeddingConfig(constraints: Record<string, unknown>): KeywordEmbeddingConfig {
  const node = (constraints.keyword_embedding as Record<string, unknown> | undefined) ?? {};
  const enabled = node.enabled === true;
  const minTotalRaw = typeof node.min_total === "number" && Number.isFinite(node.min_total) ? node.min_total : 0;
  const slotRetriesRaw =
    typeof node.slot_retries === "number" && Number.isFinite(node.slot_retries) ? node.slot_retries : 3;
  return {
    enabled,
    minTotal: Math.max(0, Math.floor(minTotalRaw)),
    enforceOrder: node.enforce_order !== false,
    exactMatch: node.exact_match !== false,
    noSplit: node.no_split !== false,
    boldWrapper: node.bold_wrapper === true,
    slotRetries: Math.max(1, Math.floor(slotRetriesRaw))
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKeywordOccurrence(
  text: string,
  keyword: string,
  start: number,
  config: KeywordEmbeddingConfig
): { start: number; end: number } | null {
  const normalizedKeyword = normalizeLine(keyword);
  if (!normalizedKeyword) {
    return null;
  }
  const tokens = normalizedKeyword
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => escapeRegExp(token));
  if (tokens.length === 0) {
    return null;
  }
  const body = config.noSplit ? tokens.join("\\s+") : tokens.join("[\\s\\W_]*");
  const wrapped = config.boldWrapper ? `\\*\\*\\s*${body}\\s*\\*\\*` : body;
  const patternText = `${config.exactMatch ? "(?<![A-Za-z0-9])" : ""}${wrapped}${config.exactMatch ? "(?![A-Za-z0-9])" : ""}`;
  const pattern = new RegExp(patternText, "i");
  const slice = text.slice(Math.max(0, start));
  const matched = pattern.exec(slice);
  if (!matched || matched.index < 0) {
    return null;
  }
  const begin = Math.max(0, start) + matched.index;
  return {
    start: begin,
    end: begin + matched[0].length
  };
}

function stripTrailingClosers(input: string): string {
  return input.replace(trailingClosersPattern, "").trim();
}

function hasCompleteSentenceEnding(input: string): boolean {
  const text = stripTrailingClosers(normalizeLine(input));
  if (!text) {
    return false;
  }
  return sentenceEndPattern.test(text);
}

function lastTailWord(input: string): string {
  let text = stripTrailingClosers(normalizeLine(input));
  text = text.replace(trailingPunctPattern, "").trim();
  if (!text) {
    return "";
  }
  const parts = text.split(/\s+/);
  const tail = (parts[parts.length - 1] || "").toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
  return tail;
}

function validateSectionContent(content: string, requirements: ListingRequirements, rule: SectionRule): string[] {
  const constraints = rule.constraints;
  const tolerance = getTolerance(constraints);
  const normalized = normalizeText(content);
  const errors: string[] = [];
  const requireCompleteSentenceEnd = constraints.require_complete_sentence_end === true;
  const forbidDanglingTail = constraints.forbid_dangling_tail === true;
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
      const lineHasCompleteEnding = hasCompleteSentenceEnding(line);
      if (requireCompleteSentenceEnd && !lineHasCompleteEnding) {
        errors.push(`第${i + 1}条结尾不是完整句子（缺少句末标点）`);
      }
      if (forbidDanglingTail && !lineHasCompleteEnding) {
        const tail = lastTailWord(line);
        if (tail && danglingTailWords.has(tail)) {
          errors.push(`第${i + 1}条结尾疑似半句（尾词: ${tail}）`);
        }
      }
    }
  }

  const minParagraphs = getNumber(constraints, "min_paragraphs", 0);
  const maxParagraphs = getNumber(constraints, "max_paragraphs", 0);
  const hasParagraphConstraint = minParagraphs > 0 || maxParagraphs > 0;
  if (hasParagraphConstraint) {
    const paragraphs = normalized
      .split(/\n\s*\n/g)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!rangeCheck(paragraphs.length, minParagraphs, maxParagraphs)) {
      errors.push(`段落数量不满足约束: ${paragraphs.length}（规则区间 ${formatRange(minParagraphs, maxParagraphs)}）`);
    }
    for (let i = 0; i < paragraphs.length; i += 1) {
      const paragraph = normalizeLine(paragraphs[i]);
      const paragraphHasCompleteEnding = hasCompleteSentenceEnding(paragraph);
      if (requireCompleteSentenceEnd && !paragraphHasCompleteEnding) {
        errors.push(`第${i + 1}段结尾不是完整句子（缺少句末标点）`);
      }
      if (forbidDanglingTail && !paragraphHasCompleteEnding) {
        const tail = lastTailWord(paragraph);
        if (tail && danglingTailWords.has(tail)) {
          errors.push(`第${i + 1}段结尾疑似半句（尾词: ${tail}）`);
        }
      }
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

  const keywordEmbedding = readKeywordEmbeddingConfig(constraints);
  if (keywordEmbedding.enabled && keywordEmbedding.minTotal > 0) {
    const keywords = requirements.keywords.map((v) => normalizeLine(v)).filter(Boolean);
    if (keywords.length < keywordEmbedding.minTotal) {
      errors.push(`关键词数量不足以满足埋入要求: ${keywords.length} < ${keywordEmbedding.minTotal}`);
    } else {
      const target = Math.min(keywordEmbedding.minTotal, keywords.length);
      const text = content.replace(/\r\n/g, "\n");
      if (keywordEmbedding.enforceOrder) {
        let cursor = 0;
        for (let i = 0; i < target; i += 1) {
          const kw = keywords[i];
          const found = findKeywordOccurrence(text, kw, cursor, keywordEmbedding);
          if (!found) {
            errors.push(`关键词顺序埋入不满足: 第${i + 1}个关键词未按顺序原样出现: ${kw}`);
            break;
          }
          cursor = found.end;
        }
      } else {
        let hits = 0;
        for (let i = 0; i < keywords.length; i += 1) {
          if (findKeywordOccurrence(text, keywords[i], 0, keywordEmbedding)) {
            hits += 1;
          }
        }
        if (hits < target) {
          errors.push(`关键词埋入数量不足: ${hits} < ${target}`);
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

export function buildSearchTermsFromRule(requirements: ListingRequirements, rule: SectionRule): string {
  const source = typeof rule.constraints.source === "string" ? rule.constraints.source : "keywords_copy";
  if (source !== "keywords_copy") {
    throw new Error(`search_terms 暂不支持 source=${source}`);
  }
  const dedupe = rule.constraints.dedupe !== false;
  const lowercase = rule.constraints.lowercase === true;
  const separator = typeof rule.constraints.separator === "string" && rule.constraints.separator !== ""
    ? rule.constraints.separator
    : " ";
  let values = dedupe ? dedupeKeepOrder(requirements.keywords) : requirements.keywords.map((v) => normalizeLine(v)).filter(Boolean);
  if (lowercase) {
    values = values.map((v) => v.toLowerCase());
  }
  return values.join(separator);
}

function renderByVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
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

function adaptSingleSentence(raw: string): string {
  const trimmed = normalizeText(raw);
  if (!trimmed) {
    return "";
  }

  const jsonText = extractJSONObjectText(trimmed);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (typeof parsed === "string") {
        return normalizeLine(stripBulletPrefix(parsed));
      }
      if (Array.isArray(parsed)) {
        const first = parsed.find((v) => typeof v === "string") as string | undefined;
        if (first) {
          return normalizeLine(stripBulletPrefix(first));
        }
      }
      if (parsed && typeof parsed === "object") {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          if (typeof value === "string") {
            return normalizeLine(stripBulletPrefix(value));
          }
          if (Array.isArray(value)) {
            const first = value.find((v) => typeof v === "string") as string | undefined;
            if (first) {
              return normalizeLine(stripBulletPrefix(first));
            }
          }
        }
      }
    } catch {
      // 非 JSON，回退到文本行提取
    }
  }

  const first = trimmed
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizeLine(stripBulletPrefix(line)))
    .find(Boolean);
  return first ?? "";
}

function stripMarkdownBold(input: string): string {
  return input.replace(/\*\*([^*]+)\*\*/g, "$1");
}

export class GenerationService {
  private readonly llmClient: LLMClient;
  private executionBrief = "";
  private currentRules: TenantRules | null = null;
  private requirementsRawForPrompt = "";

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
    private readonly traceStore: RedisTraceStore,
    private readonly traceContext: { tenantId: string; jobId: string },
    private readonly abortSignal?: AbortSignal
  ) {
    this.llmClient = new LLMClient(env, logger, traceStore, traceContext, abortSignal);
  }

  private isAbortLikeError(error: unknown): boolean {
    if (this.abortSignal?.aborted) {
      return true;
    }
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return msg.includes("abort");
  }

  private throwIfAborted(): void {
    if (this.abortSignal?.aborted) {
      throw new Error("job cancelled");
    }
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
    const requirementsRaw = this.requirementsRawForPrompt || requirements.raw;
    return [
      `任务: 生成 section=${section}（英文）`,
      this.executionBrief ? `执行简报:\n${this.executionBrief}` : "",
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${keywords}`,
      "输入需求原文:",
      requirementsRaw,
      extra ? `\n修正反馈:\n${extra}` : ""
    ].join("\n");
  }

  private isSentenceMode(rule: SectionRule): boolean {
    return rule.execution.generation_mode === "sentence";
  }

  private resolveSentenceModeCount(rule: SectionRule): number {
    const configured = rule.execution.sentence_count;
    if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    const lineCount = getNumber(rule.constraints, "line_count", 0);
    if (lineCount > 0) {
      return lineCount;
    }
    return 0;
  }

  private sentenceKeywordPlan(
    requirements: ListingRequirements,
    rule: SectionRule,
    sentenceCount: number
  ): { config: KeywordEmbeddingConfig; slots: string[][] } {
    const config = readKeywordEmbeddingConfig(rule.constraints);
    const slots = Array.from({ length: sentenceCount }, () => [] as string[]);
    if (!config.enabled || config.minTotal <= 0 || sentenceCount <= 0) {
      return { config, slots };
    }
    const keywords = requirements.keywords.map((v) => normalizeLine(v)).filter(Boolean);
    const target = Math.min(config.minTotal, keywords.length);
    if (target <= 0) {
      return { config, slots };
    }
    const base = Math.floor(target / sentenceCount);
    const remainder = target % sentenceCount;
    let cursor = 0;
    for (let i = 0; i < sentenceCount; i += 1) {
      const take = base + (i < remainder ? 1 : 0);
      for (let j = 0; j < take; j += 1) {
        if (cursor >= target) {
          break;
        }
        slots[i].push(keywords[cursor]);
        cursor += 1;
      }
    }
    return { config, slots };
  }

  private validateSentenceRequiredKeywords(
    sentence: string,
    requiredKeywords: string[],
    config: KeywordEmbeddingConfig
  ): string | null {
    if (requiredKeywords.length === 0) {
      return null;
    }
    let cursor = 0;
    for (let i = 0; i < requiredKeywords.length; i += 1) {
      const kw = requiredKeywords[i];
      const found = findKeywordOccurrence(sentence, kw, cursor, config);
      if (!found) {
        return `第${i + 1}个要求关键词未按顺序原样出现: ${kw}`;
      }
      cursor = found.end;
    }
    return null;
  }

  private splitSentenceSlotsByParagraphs(sentences: string[], paragraphCount: number): string {
    if (paragraphCount <= 1) {
      return normalizeText(sentences.join(" "));
    }
    const safeParagraphCount = Math.max(1, Math.min(paragraphCount, sentences.length || 1));
    const baseSize = Math.floor(sentences.length / safeParagraphCount);
    const remainder = sentences.length % safeParagraphCount;
    const paragraphs: string[] = [];
    let cursor = 0;
    for (let i = 0; i < safeParagraphCount; i += 1) {
      const take = baseSize + (i < remainder ? 1 : 0);
      const chunk = sentences.slice(cursor, cursor + Math.max(1, take));
      cursor += Math.max(1, take);
      paragraphs.push(normalizeText(chunk.join(" ")));
    }
    return normalizeText(paragraphs.join("\n\n"));
  }

  private sentenceTargetRange(rule: SectionRule, sentenceCount: number): { min: number; max: number } {
    if (sentenceCount <= 0) {
      return { min: 0, max: 0 };
    }
    const tolerance = getTolerance(rule.constraints);
    const lineCount = getNumber(rule.constraints, "line_count", 0);
    const rawMinPerLine = getNumber(rule.constraints, "min_chars_per_line", 0);
    const rawMaxPerLine = getNumber(rule.constraints, "max_chars_per_line", 0);
    if (lineCount > 0 && (rawMinPerLine > 0 || rawMaxPerLine > 0)) {
      return {
        min: rawMinPerLine > 0 ? Math.max(0, rawMinPerLine - tolerance) : 0,
        max: rawMaxPerLine > 0 ? rawMaxPerLine + tolerance : 0
      };
    }
    const rawMin = getNumber(rule.constraints, "min_chars", 0);
    const rawMax = getNumber(rule.constraints, "max_chars", 0);
    const minTotal = rawMin > 0 ? Math.max(0, rawMin - tolerance) : 0;
    const maxTotal = rawMax > 0 ? rawMax + tolerance : 0;
    const perSentenceSlack = Math.max(0, getNumber(rule.constraints, "sentence_target_slack", 30));
    const avgMin = minTotal > 0 ? Math.max(1, Math.ceil(minTotal / sentenceCount)) : 0;
    const avgMax = maxTotal > 0 ? Math.max(1, Math.floor(maxTotal / sentenceCount)) : 0;
    const minWithSlack = avgMin > 0 ? Math.max(1, avgMin - perSentenceSlack) : 0;
    const maxWithSlack = avgMax > 0 ? avgMax + perSentenceSlack : 0;
    return {
      min: minWithSlack,
      max: maxWithSlack
    };
  }

  private assembleSentenceModeContent(rule: SectionRule, sentences: string[]): string {
    const lineCount = getNumber(rule.constraints, "line_count", 0);
    if (lineCount > 0) {
      return normalizeText(sentences.slice(0, lineCount).join("\n"));
    }

    const minParagraphs = getNumber(rule.constraints, "min_paragraphs", 0);
    const maxParagraphs = getNumber(rule.constraints, "max_paragraphs", 0);
    const fixedParagraphs =
      minParagraphs > 0 && maxParagraphs > 0 && minParagraphs === maxParagraphs ? minParagraphs : 0;
    const paragraphCount = rule.execution.paragraph_count ?? fixedParagraphs;
    if (paragraphCount > 0) {
      return this.splitSentenceSlotsByParagraphs(sentences, paragraphCount);
    }
    return normalizeText(sentences.join(" "));
  }

  private buildSentenceModeSystemPrompt(rule: SectionRule): string {
    const constraintsSummary = this.constraintsSummary(rule);
    return [
      "你是专业亚马逊 Listing 文案专家。",
      "你在逐句生成模式中工作。",
      "每次只输出 1 句英文完整句子，不要编号，不要项目符号，不要解释，不要 JSON，不要代码块。",
      "句子必须完整收尾并带句末标点，禁止半截句。",
      `section=${rule.section}`,
      `规则:\n${rule.instruction}`,
      `硬性约束摘要:\n${constraintsSummary}`
    ].join("\n");
  }

  private buildSentenceModeUserPrompt(
    requirements: ListingRequirements,
    rule: SectionRule,
    sentenceIndex: number,
    sentenceCount: number,
    generatedSentences: string[],
    requiredKeywords: string[],
    sentenceTarget: { min: number; max: number },
    extra?: string
  ): string {
    const requirementsRaw = this.requirementsRawForPrompt || requirements.raw;
    const doneText = generatedSentences.length > 0 ? generatedSentences.join("\n") : "（暂无）";
    return [
      `任务: 生成 section=${rule.section} 的第 ${sentenceIndex + 1}/${sentenceCount} 句（英文）`,
      this.executionBrief ? `执行简报:\n${this.executionBrief}` : "",
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${requirements.keywords.join("\n")}`,
      requiredKeywords.length > 0
        ? `本句必须按顺序原样包含以下关键词（不得拆分/改写/换序）:\n${requiredKeywords.map((v, i) => `${i + 1}. ${v}`).join("\n")}`
        : "",
      requiredKeywords.length > 0 && keywordPlanBoldWrapper(rule)
        ? "本句中每个关键词必须使用 Markdown 粗体包裹，格式为 **关键词**。"
        : "",
      sentenceTarget.min > 0 || sentenceTarget.max > 0
        ? `本句目标长度（字符）: ${formatRange(sentenceTarget.min, sentenceTarget.max)}`
        : "",
      `已生成句子:\n${doneText}`,
      "输入需求原文:",
      requirementsRaw,
      extra ? `\n修正反馈:\n${extra}` : "",
      "只返回这一句英文正文。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async generateSectionWithSentenceMode(
    requirements: ListingRequirements,
    rule: SectionRule,
    step: string,
    validate: (content: string) => string[],
    options?: SectionGenerateOptions
  ): Promise<string> {
    const retries = Math.max(1, options?.maxRetries ?? rule.execution.retries ?? 3);
    const sentenceCount = this.resolveSentenceModeCount(rule);
    if (sentenceCount <= 0) {
      throw new Error(`${rule.section} 逐句模式缺少 sentence_count/line_count 配置`);
    }
    const apiAttempts = Math.max(2, getNumber(rule.constraints, "api_attempts", 4));
    const keywordPlan = this.sentenceKeywordPlan(requirements, rule, sentenceCount);
    const sentenceTarget = this.sentenceTargetRange(rule, sentenceCount);
    let feedback = options?.initialFeedback?.trim() ?? "";

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      this.throwIfAborted();
      const started = Date.now();
      await this.appendTrace("section_sentence_mode_start", "info", {
        step,
        section: rule.section,
        attempt,
        max_attempts: retries,
        sentence_count: sentenceCount
      });

      const sentences: string[] = [];
      for (let idx = 0; idx < sentenceCount; idx += 1) {
        const requiredKeywords = keywordPlan.slots[idx] ?? [];
        let sentenceFeedback = feedback;
        let produced = "";
        const slotRetries = keywordPlan.config.slotRetries;
        for (let slotAttempt = 1; slotAttempt <= slotRetries; slotAttempt += 1) {
          this.throwIfAborted();
          const sentenceStarted = Date.now();
          const raw = await this.llmClient.writeWithWriterAgent(
            this.buildSentenceModeSystemPrompt(rule),
            this.buildSentenceModeUserPrompt(
              requirements,
              rule,
              idx,
              sentenceCount,
              sentences,
              requiredKeywords,
              sentenceTarget,
              sentenceFeedback
            ),
            `${step}_sentence_${idx + 1}_attempt_${attempt}_slot_${slotAttempt}`,
            apiAttempts,
            options?.writerModelSettings
          );
          const sentence = adaptSingleSentence(raw);
          if (!sentence) {
            sentenceFeedback = `- 本句为空，请输出 1 句完整英文句子。`;
            if (slotAttempt >= slotRetries) {
              await this.appendTrace("section_sentence_step_validate_fail", "warn", {
                step,
                section: rule.section,
                sentence_index: idx + 1,
                sentence_total: sentenceCount,
                slot_attempt: slotAttempt,
                error: "本句为空"
              });
            }
            continue;
          }
          const sentenceChars = normalizeLine(sentence).length;
          if (!rangeCheck(sentenceChars, sentenceTarget.min, sentenceTarget.max)) {
            const rangeText = formatRange(sentenceTarget.min, sentenceTarget.max);
            const sentenceErr = `句长不满足目标: ${sentenceChars}（目标 ${rangeText}）`;
            sentenceFeedback = `- ${sentenceErr}`;
            if (slotAttempt >= slotRetries) {
              await this.appendTrace("section_sentence_step_validate_fail", "warn", {
                step,
                section: rule.section,
                sentence_index: idx + 1,
                sentence_total: sentenceCount,
                slot_attempt: slotAttempt,
                error: sentenceErr
              });
            }
            if (slotAttempt >= slotRetries) {
              throw new Error(`${step} 第${idx + 1}句长度约束失败: ${sentenceErr}`);
            }
            continue;
          }
          const keywordError = this.validateSentenceRequiredKeywords(sentence, requiredKeywords, keywordPlan.config);
          if (keywordError) {
            sentenceFeedback = `- ${keywordError}`;
            if (slotAttempt >= slotRetries) {
              await this.appendTrace("section_sentence_step_validate_fail", "warn", {
                step,
                section: rule.section,
                sentence_index: idx + 1,
                sentence_total: sentenceCount,
                slot_attempt: slotAttempt,
                error: keywordError
              });
            }
            if (slotAttempt >= slotRetries) {
              throw new Error(`${step} 第${idx + 1}句关键词约束失败: ${keywordError}`);
            }
            continue;
          }
          produced = sentence;
          await this.appendTrace("section_sentence_step_ok", "info", {
            step,
            section: rule.section,
            sentence_index: idx + 1,
            sentence_total: sentenceCount,
            slot_attempt: slotAttempt,
            duration_ms: Date.now() - sentenceStarted,
            output_chars: sentenceChars
          });
          break;
        }
        if (!produced) {
          throw new Error(`${step} 第${idx + 1}句生成失败`);
        }
        sentences.push(produced);
      }

      const merged = this.assembleSentenceModeContent(rule, sentences);
      const errors = validate(merged);
      if (errors.length === 0) {
        await this.appendTrace("section_sentence_mode_ok", "info", {
          step,
          section: rule.section,
          attempt,
          duration_ms: Date.now() - started,
          output_chars: merged.length,
          sentence_count: sentenceCount
        });
        return merged;
      }

      feedback = compactErrorsForLLM(errors, 8).map((err) => `- ${err}`).join("\n");
      await this.appendTrace("section_sentence_mode_validate_fail", "warn", {
        step,
        section: rule.section,
        attempt,
        errors
      });

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
    if (constraints.require_complete_sentence_end === true) {
      lines.push("- 每条或每段必须以完整句收尾（句末标点）");
    }
    if (constraints.forbid_dangling_tail === true) {
      lines.push("- 禁止半截句结尾（如 to/and/with 等悬空尾词）");
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
      "严禁通过截断尾部满足长度，必须重写为完整句，并用句末标点收尾。",
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
      "只返回修复后的这一行英文文本，必须完整收尾。"
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
        lines[idx] = normalizedLine;
      }

      const merged = normalizeText(lines.join("\n"));
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
      "严禁通过截断尾部满足长度，必须重写为完整句，并用句末标点收尾。",
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
        ? "请重写内容并一次性满足约束。禁止输出半句，禁止截断收尾。只输出修复后的 JSON 对象。"
        : "请重写整段内容，必须一次性满足约束。禁止输出半句，禁止截断收尾。只输出修复后正文。"
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
    const normalized = normalizeText(adapted.content);
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
    if (this.isSentenceMode(rule)) {
      return this.generateSectionWithSentenceMode(requirements, rule, step, validate, options);
    }
    this.throwIfAborted();
    const retries = Math.max(1, options?.maxRetries ?? rule.execution.retries ?? 3);
    const apiAttempts = Math.max(2, getNumber(rule.constraints, "api_attempts", 4));
    let feedback = options?.initialFeedback?.trim() ?? "";

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      this.throwIfAborted();
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
      const normalized = normalizeText(adapted.content);
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

  private groupJudgeIssuesBySection(issues: JudgeIssue[]): Record<string, string[]> {
    const grouped: Record<string, string[]> = {};
    for (const issue of issues) {
      if (!grouped[issue.section]) {
        grouped[issue.section] = [];
      }
      grouped[issue.section].push(issue.message);
    }
    return grouped;
  }

  private buildJudgeFeedbackText(messages: string[]): string {
    return messages.map((message) => `- ${message}`).join("\n");
  }

  private async translateText(text: string, step: string, retries: number): Promise<string> {
    this.throwIfAborted();
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
    sections?: Record<string, string>
  ): Record<string, string> {
    const requirementsRaw = this.requirementsRawForPrompt || requirements.raw;
    return {
      brand: requirements.brand,
      category: requirements.category,
      keywords: requirements.keywords.join("\n"),
      requirements_raw: requirementsRaw,
      ...(requirements.values
        ? Object.fromEntries(
            Object.entries(requirements.values).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join("\n") : String(value ?? "")
            ])
          )
        : {}),
      ...(sections ?? {})
    };
  }

  private async planExecution(requirements: ListingRequirements): Promise<string> {
    this.throwIfAborted();
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
      if (this.isAbortLikeError(error)) {
        throw error;
      }
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
    return parseJudgeIssues(text, rules.workflow.judge.ignore_messages, [...rules.sections.keys()]);
  }

  private async runQualityJudge(
    requirements: ListingRequirements,
    sections: Record<string, string>
  ): Promise<JudgeIssue[]> {
    this.throwIfAborted();
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
      const allIssues = this.parseJudgeIssues(judgeOutput);
      const skipSet = new Set(rules.workflow.judge.skip_sections.map((v) => v.toLowerCase()));
      const dropped: JudgeIssue[] = [];
      const issues: JudgeIssue[] = [];
      for (const issue of allIssues) {
        if (issue.section === "search_terms") {
          dropped.push(issue);
          continue;
        }
        if (skipSet.has(issue.section.toLowerCase())) {
          dropped.push(issue);
          continue;
        }
        issues.push(issue);
      }
      if (dropped.length > 0) {
        await this.appendTrace("quality_judge_issues_skipped", "warn", {
          skipped_count: dropped.length,
          skipped_issues: dropped
        });
      }
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
      if (this.isAbortLikeError(error)) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      await this.appendTrace("quality_judge_failed", "warn", {
        duration_ms: Date.now() - started,
        error: msg
      });
      this.logger.warn({ event: "quality_judge_failed", error: msg }, "quality judge failed");
      return [];
    }
  }

  private workflowSectionRule(section: string): SectionRule {
    const rules = this.mustRulesLoaded();
    const rule = rules.sections.get(section);
    if (!rule) {
      throw new Error(`规则文件缺失 section: ${section}`);
    }
    return rule;
  }

  private workflowTranslateStep(inputSlot: string): string {
    const normalized = inputSlot.trim().toLowerCase();
    switch (normalized) {
      case "category":
        return "translate_category";
      case "keywords":
        return "translate_keywords";
      case "title_en":
        return "translate_title";
      case "bullets_en":
        return "translate_bullets";
      case "description_en":
        return "translate_description";
      case "search_terms_en":
        return "translate_search_terms";
      default:
        return `translate_${normalized}`;
    }
  }

  private buildInitialExecutionContext(requirements: ListingRequirements): ExecutionContext {
    return new ExecutionContext({
      brand: requirements.brand,
      category: requirements.category,
      keywords: requirements.keywords.join("\n")
    });
  }

  private buildRenderVarsFromContext(node: WorkflowNode, ctx: ExecutionContext): Record<string, string> {
    const rules = this.mustRulesLoaded();
    return buildRenderVariables(node, ctx, {
      inputFields: rules.input.fields,
      sections: rules.sections,
      render: rules.workflow.render
    });
  }

  private async executeGenerateNode(requirements: ListingRequirements, node: WorkflowNode): Promise<string> {
    const section = (node.section ?? "").trim();
    const rule = this.workflowSectionRule(section);
    const step = rule.section;
    if (rule.section === "bullets") {
      const bulletsJSONModeSettings = this.deepseekJSONModeSettings();
      const bulletsJSONArrayField = rule.output.json_array_field || "bullets";
      return this.generateSectionWithValidation(
        requirements,
        rule,
        step,
        (content) => validateSectionContent(content, requirements, rule),
        {
          jsonOutput: true,
          writerModelSettings: bulletsJSONModeSettings,
          repairModelSettings: bulletsJSONModeSettings,
          adaptContent: (raw) => adaptJSONArrayContent(raw, bulletsJSONArrayField)
        }
      );
    }
    return this.generateSectionWithValidation(
      requirements,
      rule,
      step,
      (content) => validateSectionContent(content, requirements, rule)
    );
  }

  private async executeTranslateNode(
    ctx: ExecutionContext,
    node: WorkflowNode,
    translationRetries: number
  ): Promise<string> {
    const inputSlot = (node.input_from ?? "").trim();
    if (!inputSlot) {
      throw new Error(`workflow translate node 缺少 input_from: ${node.id}`);
    }
    const text = ctx.get(inputSlot);
    const translated = await this.translateText(text, this.workflowTranslateStep(inputSlot), translationRetries);
    if (node.output_to === "bullets_cn" || node.output_to === "description_cn") {
      return stripMarkdownBold(translated);
    }
    return translated;
  }

  private async executeDeriveNode(requirements: ListingRequirements, node: WorkflowNode): Promise<string> {
    const section = (node.section ?? "").trim();
    const rule = this.workflowSectionRule(section);
    if (section === "search_terms") {
      return buildSearchTermsFromRule(requirements, rule);
    }
    throw new Error(`workflow derive 暂不支持 section: ${section}`);
  }

  private async executeJudgeNode(
    requirements: ListingRequirements,
    node: WorkflowNode,
    ctx: ExecutionContext
  ): Promise<NodeExecutionResult> {
    const maxJudgeRounds = this.mustRulesLoaded().workflow.judge.max_rounds;
    const boundSections = collectNodeSectionSlots(node, ctx);
    const repairedSections: Record<string, string> = { ...boundSections };

    let judgeIssues = await this.runQualityJudge(requirements, repairedSections);

    for (let judgeRound = 1; judgeRound <= maxJudgeRounds && judgeIssues.length > 0; judgeRound += 1) {
      this.throwIfAborted();
      const grouped = this.groupJudgeIssuesBySection(judgeIssues);
      await this.appendTrace("quality_judge_repair_round_start", "warn", {
        step: node.id,
        round: judgeRound,
        issues_count: judgeIssues.length,
        grouped
      });

      for (const [section, messages] of Object.entries(grouped)) {
        if (!messages.length) {
          continue;
        }
        const slot = node.inputs?.[section];
        if (!slot) {
          continue;
        }
        const rule = this.workflowSectionRule(section);
        const jsonOutput = rule.output.format === "json";
        const jsonArrayField = rule.output.json_array_field || section;
        const modelSettings = jsonOutput ? this.deepseekJSONModeSettings() : undefined;
        const repaired = await this.generateSectionWithValidation(
          requirements,
          rule,
          `${section}_judge_repair_round_${judgeRound}`,
          (content) => validateSectionContent(content, requirements, rule),
          {
            initialFeedback: this.buildJudgeFeedbackText(messages),
            maxRetries: 2,
            jsonOutput,
            writerModelSettings: modelSettings,
            repairModelSettings: modelSettings,
            adaptContent: jsonOutput ? (raw) => adaptJSONArrayContent(raw, jsonArrayField) : undefined
          }
        );
        repairedSections[section] = repaired;
        ctx.set(slot, normalizeText(repaired));
      }

      judgeIssues = await this.runQualityJudge(requirements, repairedSections);
    }

    return {
      outputSlot: node.output_to,
      outputValue: String(judgeIssues.length),
      writes: Object.fromEntries(
        Object.entries(node.inputs ?? {})
          .filter(([section]) => typeof repairedSections[section] === "string")
          .map(([section, slot]) => [slot, normalizeText(repairedSections[section] ?? "")])
      )
    };
  }

  private async executeRenderNode(ctx: ExecutionContext, node: WorkflowNode): Promise<string> {
    const rules = this.mustRulesLoaded();
    const templateKey = (node.template ?? "").trim();
    if (templateKey !== "en" && templateKey !== "cn") {
      throw new Error(`workflow render 暂不支持 template: ${templateKey}`);
    }
    const vars = this.buildRenderVarsFromContext(node, ctx);
    return normalizeText(renderByVars(rules.templates[templateKey], vars));
  }

  private createWorkflowRegistry(
    requirements: ListingRequirements,
    translationRetries: number
  ): ExecutorRegistry {
    return new ExecutorRegistry([
      new GenerateNodeExecutor((node) => this.executeGenerateNode(requirements, node)),
      new TranslateNodeExecutor((node, ctx) => this.executeTranslateNode(ctx, node, translationRetries)),
      new DeriveNodeExecutor(async (node) => ({
        outputSlot: node.output_to,
        outputValue: await this.executeDeriveNode(requirements, node)
      })),
      new JudgeNodeExecutor((node, ctx) => this.executeJudgeNode(requirements, node, ctx)),
      new RenderNodeExecutor(this.mustRulesLoaded().templates, async (node, ctx) => ({
        outputSlot: node.output_to,
        outputValue: await this.executeRenderNode(ctx, node)
      }))
    ]);
  }

  private async executeWorkflow(
    requirements: ListingRequirements,
    tenantRules: TenantRules,
    inputFilename: string,
    translationRetries: number
  ): Promise<WorkflowExecutionOutput> {
    const graph = buildWorkflowGraph(tenantRules.workflow.spec);
    const ctx = this.buildInitialExecutionContext(requirements);
    const engine = new WorkflowEngine(graph, this.createWorkflowRegistry(requirements, translationRetries));
    await engine.run(ctx);

    const enMarkdown = replaceTopHeading(normalizeText(ctx.get("en_markdown")), inputFilename);
    const cnMarkdown = replaceTopHeading(normalizeText(ctx.get("cn_markdown")), inputFilename);
    const bulletsCount = splitLines(ctx.get("bullets_en")).length;
    const judgeIssuesCount = Number.parseInt(ctx.has("judge_report_round_1") ? ctx.get("judge_report_round_1") : "0", 10);

    return {
      enMarkdown,
      cnMarkdown,
      bulletsCount,
      judgeIssuesCount: Number.isFinite(judgeIssuesCount) ? judgeIssuesCount : 0
    };
  }

  async generate(input: GenerationInput): Promise<ListingResult> {
    this.throwIfAborted();
    const start = Date.now();
    this.executionBrief = "";
    this.requirementsRawForPrompt = "";
    const inputFilename = normalizeInputFilename(input.inputFilename);
    await this.appendTrace("generation_start", "info", {
      tenant_id: input.tenantId,
      job_id: input.jobId,
      rules_version: input.rulesVersion,
      input_chars: input.inputMarkdown.length,
      input_filename: inputFilename || undefined
    });
    this.logger.info(
      {
        event: "generation_start",
        tenant_id: input.tenantId,
        job_id: input.jobId,
        rules_version: input.rulesVersion,
        input_chars: input.inputMarkdown.length,
        input_filename: inputFilename || undefined
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
    const promptRaw = compactRequirementsRawForPrompt(requirements.raw);
    this.requirementsRawForPrompt = promptRaw.text;
    await this.appendTrace("requirements_raw_compacted", "info", {
      original_chars: promptRaw.originalChars,
      final_chars: promptRaw.finalChars,
      cut_by_marker: promptRaw.cutByMarker,
      truncated: promptRaw.truncated
    });

    if (!requirements.category) {
      await this.appendTrace("generation_invalid_input", "error", { error: "缺少分类" });
      throw new InputValidationError("缺少分类");
    }
    const keywordsField = tenantRules.input.fields.find((field) => field.key === "keywords");
    const minKeywordCount = Math.max(1, keywordsField?.min_count || 3);
    if (requirements.keywords.length < minKeywordCount) {
      await this.appendTrace("generation_invalid_input", "error", {
        error: `关键词数量不足：${requirements.keywords.length} < ${minKeywordCount}`,
        keywords_count: requirements.keywords.length,
        min_keyword_count: minKeywordCount
      });
      throw new InputValidationError(`关键词数量不足：${requirements.keywords.length} < ${minKeywordCount}`);
    }
    if (keywordsField?.unique_required) {
      const duplicates = duplicateKeywords(requirements.keywords);
      if (duplicates.length > 0) {
        const duplicateText = formatDuplicateKeywords(duplicates);
        await this.appendTrace("generation_invalid_input", "error", {
          error: `关键词存在重复：${duplicateText}`,
          duplicate_keywords: duplicates.map((item) => item.keyword),
          duplicate_keyword_details: duplicates
        });
        throw new InputValidationError(`关键词存在重复：${duplicateText}`);
      }
    }

    const translationRule = tenantRules.sections.get("translation");

    if (!translationRule) {
      const existsPayload: Record<string, unknown> = {};
      for (const key of tenantRules.requiredSections) {
        existsPayload[key] = tenantRules.sections.has(key);
      }
      await this.appendTrace("rules_missing_sections", "error", existsPayload);
      throw new Error("规则文件缺失：translation 必须齐全");
    }

    const translationRetries = Math.max(1, translationRule.execution.retries || 2);
    this.executionBrief = await this.planExecution(requirements);
    this.throwIfAborted();
    const workflowOutput = await this.executeWorkflow(requirements, tenantRules, inputFilename, translationRetries);
    this.throwIfAborted();

    this.logger.info(
      {
        event: "generation_ok",
        tenant_id: input.tenantId,
        job_id: input.jobId,
        rules_version: input.rulesVersion,
        timing_ms: Date.now() - start,
        en_chars: workflowOutput.enMarkdown.length,
        cn_chars: workflowOutput.cnMarkdown.length
      },
      "generation ok"
    );
    await this.appendTrace("generation_ok", "info", {
      rules_version: input.rulesVersion,
      timing_ms: Date.now() - start,
      en_chars: workflowOutput.enMarkdown.length,
      cn_chars: workflowOutput.cnMarkdown.length
    });

    return {
      en_markdown: workflowOutput.enMarkdown,
      cn_markdown: workflowOutput.cnMarkdown,
      validation_report: [
        `rules_version=${input.rulesVersion}`,
        `keywords_count=${requirements.keywords.length}`,
        `bullets_count=${workflowOutput.bulletsCount}`,
        `judge_issues_count=${workflowOutput.judgeIssuesCount}`
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

function keywordPlanBoldWrapper(rule: SectionRule): boolean {
  const config = readKeywordEmbeddingConfig(rule.constraints);
  return config.enabled && config.boldWrapper;
}
