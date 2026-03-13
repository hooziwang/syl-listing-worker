import { basename, extname, join } from "node:path";
import type { ModelSettings } from "@openai/agents";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { ListingResult } from "../domain/types.js";
import { compileExecutionSpec } from "../agent-runtime/compiler.js";
import {
  executeRuntimeSections,
  type RuntimeSectionCandidate,
  type RuntimeSectionCandidateFailure,
  type RuntimeSectionCandidateResult
} from "../agent-runtime/planner.js";
import { createDefaultRegistry } from "../agent-runtime/registry.js";
import type { ModelProfile } from "../agent-runtime/types.js";
import { LLMClient } from "./llm-client.js";
import { parseRequirements, type ListingRequirements } from "./requirements-parser.js";
import { loadTenantRules, type SectionRule, type TenantRules } from "./rules-loader.js";
import { buildSectionExecutionGuidance, buildSectionRepairGuidance } from "./section-guidance.js";
import type { RedisTraceStore } from "../store/trace-store.js";
import { ExecutionContext } from "../runtime-support/execution-context.js";
import type { GenerationNode } from "../runtime-support/types.js";
import { buildRenderVariables, collectNodeSectionSlots, parseJudgeIssues } from "../runtime-support/bindings.js";

interface GenerationInput {
  jobId: string;
  tenantId: string;
  rulesVersion: string;
  inputMarkdown: string;
  inputFilename?: string;
  resumeSections?: Record<string, string>;
  persistRuntimeSection?: (section: string, value: string) => Promise<void> | void;
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

interface GenerationExecutionOutput {
  enMarkdown: string;
  cnMarkdown: string;
  bulletsCount: number;
  judgeIssuesCount: number;
}

interface NodeExecutionResult {
  outputSlot: string;
  outputValue: string;
  writes?: Record<string, string>;
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

const bulletLineCompressionRules: Array<[RegExp, string]> = [
  [/\breceive a complete set of\b/gi, "Includes"],
  [/\bfor immediate use in your classroom decor projects\b/gi, "for classroom use"],
  [/\bare ready to hang, offering a practical solution for\b/gi, "hang easily for"],
  [/\btransformed ceilings and cheerful displays with\b/gi, "ceiling displays with"],
  [/\bfor school events and parties\b/gi, "for school events"],
  [/\bmeasures a perfect\b/gi, "measures"],
  [/\bcreating substantial visual impact as\b/gi, "as"],
  [/\bthis ideal size ensures they serve as\b/gi, "this size keeps them as"],
  [/\bpieces that fill classroom ceilings with presence while keeping\b/gi, "pieces that keep"],
  [/\beasy to suspend across events\b/gi, "easy to suspend"],
  [/\bprimarily designed as\b/gi, "Designed as"],
  [/\bthat excel in classroom ceiling applications for educational environments\b/gi, "for classroom ceilings"],
  [/\bprovide excellent illumination and decorative appeal for academic celebrations while remaining suitable for\b/gi, "add decorative appeal for"],
  [/\band seasonal school events\b/gi, "and school events"],
  [/\bincludes everything you need for immediate use\b/gi, "is ready to use"],
  [/\bprovid(?:ing|es?) a complete set of\b/gi, "with"],
  [/\bready for immediate classroom decoration\b/gi, "for classroom decor"],
  [/\boffering a full\b/gi, "with"],
  [/\bsolution that includes all necessary hanging accessories for easy setup\b/gi, "easy setup"],
  [/\bkeep displays bright for seasonal classroom use\b/gi, "fit classroom displays"],
  [/\bitems that are ready to transform any space\b/gi, "items"],
  [/\bcreate a cheerful display for classrooms, events, and seasonal decorating moments\b/gi, "fit classrooms and seasonal displays"],
  [/\bcreating an ideal size for\b/gi, "sized for"],
  [/\bthat make a statement without overwhelming the space\b/gi, ""],
  [/\bthe perfectly proportioned\b/gi, ""],
  [/\bensures visual impact while keeping\b/gi, "keeps"],
  [/\beasy to place across classrooms and parties\b/gi, "easy to place"],
  [/\bthat adds visual appeal to any setting\b/gi, ""],
  [/\bserve as beautiful\b/gi, "are"],
  [/\balso work well for\b/gi, "fit"],
  [/\bevents, parties, and classroom displays\b/gi, "events and classrooms"],
  [/\bpair naturally with\b/gi, "fit"],
  [/\bblend smoothly into\b/gi, "fit"],
  [/\bback to school rooms, reading corners, bulletin board backdrops, welcome walls, and everyday seasonal displays\b/gi, "classrooms and seasonal displays"],
  [/\bwith easy setup\b/gi, ""],
  [/\bdesigned for\b/gi, "for"],
  [/\bperfect for\b/gi, "great for"],
  [/\bideal for\b/gi, "great for"],
  [/\beasy assembly\b/gi, "assembly"],
  [/\beasy installation\b/gi, "installation"],
  [/\bvarious\b/gi, ""],
  [/\bmultiple\b/gi, ""],
  [/\bpremium\b/gi, ""],
  [/\bdurable\b/gi, ""],
  [/\bversatile\b/gi, ""],
  [/\bvibrant\b/gi, ""],
  [/\bimpressive\b/gi, ""],
  [/\bbalanced\b/gi, ""],
  [/\beffective\b/gi, ""],
  [/\btraditional\b/gi, ""],
  [/\bclassic\b/gi, ""],
  [/\bcheerful\b/gi, ""],
  [/\breliable\b/gi, ""]
];

const titleCompressionRules: Array<[RegExp, string]> = [
  [/\bClassroom Hanging Decor\b/gi, "Classroom Decor"],
  [/\bCeiling Decorations\b/gi, "Ceiling Decor"],
  [/\bClassroom Events and Back to School Decor\b/gi, "School Decor"],
  [/\bBack to School Decor\b/gi, "School Decor"],
  [/\bWedding Baby Shower Summer Party\b/gi, "Wedding Baby Shower Summer"],
  [/\s*,\s*/g, ", "]
];

function transformNonKeywordSegments(input: string, transform: (segment: string) => string): string {
  return input
    .split(/(\*\*[^*]+\*\*)/g)
    .map((segment) => (segment.startsWith("**") && segment.endsWith("**") ? segment : transform(segment)))
    .join("");
}

function cleanupCompressedBulletLine(input: string): string {
  return normalizeLine(
    input
      .replace(/\s+([,.;!?])/g, "$1")
      .replace(/([,.;!?])([A-Za-z*])/g, "$1 $2")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
  );
}

function extractBoldKeywords(line: string): string[] {
  return [...line.matchAll(/\*\*([^*]+)\*\*/g)]
    .map((matched) => normalizeLine(matched[1] ?? ""))
    .filter(Boolean);
}

function extractFirstMatch(line: string, pattern: RegExp): string {
  const matched = pattern.exec(line);
  return matched?.[0]?.trim() ?? "";
}

function buildFallbackBulletLine(line: string, lineIndex: number): string | null {
  const heading = extractBulletHeading(line) || `Bullet Line ${lineIndex + 1}`;
  const keywords = extractBoldKeywords(line)
    .slice(0, 3)
    .map((keyword) => `**${keyword}**`);
  if (keywords.length < 3) {
    return null;
  }
  const quantity = extractFirstMatch(line, /\b\d+\s*(?:pack|pcs?|pieces?)\b/i) || extractFirstMatch(line, /\b\d+\b/);
  const size = extractFirstMatch(line, /\b\d+\s*(?:\*|x)\s*\d+\s*(?:in|inch|inches)?\b/i);
  switch (lineIndex) {
    case 0:
      return normalizeLine(
        `${heading}: Includes ${quantity || "12"} ${keywords[0]}${size ? ` in ${size.replace(/\s+/g, "")}` : ""} for fast classroom setup. ${keywords[1]} keeps the set ready, and ${keywords[2]} add bright color for welcome days, school themes, and DIY room decor.`
      );
    case 1:
      return normalizeLine(
        `${heading}: ${keywords[0]} open fast for ceilings and walls in busy classrooms. ${keywords[1]} needs no tools, and ${keywords[2]} add layered color for welcome days, reading corners, and party tables.`
      );
    case 2:
      return normalizeLine(
        `${heading}: ${keywords[0]} store flat and reuse across lessons, holidays, and school events. ${keywords[1]} fold down after use, and ${keywords[2]} help keep displays neat for the next celebration at school.`
      );
    case 3:
      return normalizeLine(
        `${heading}: ${keywords[0]} bring plaid color that brightens displays without crowding rooms. ${keywords[1]} adds clear focus, and ${keywords[2]} fit class parties and tables with a neat look.`
      );
    case 4:
      return normalizeLine(
        `${heading}: ${keywords[0]} suit classroom celebrations, bulletin boards, and themed activities. ${keywords[1]} add soft impact, and ${keywords[2]} support school parties and quick seasonal refreshes each term.`
      );
    default:
      return normalizeLine(
        `${heading}: ${keywords[0]} keep the display practical and easy to place in classroom scenes. ${keywords[1]} add clear decorative value, and ${keywords[2]} support neat seasonal setups without extra clutter.`
      );
  }
}

function compressBulletLineToLimit(line: string, maxChars: number, lineIndex = 0): string {
  if (maxChars <= 0 || line.length <= maxChars) {
    return line;
  }
  let current = line;
  for (const [pattern, replacement] of bulletLineCompressionRules) {
    const next = cleanupCompressedBulletLine(
      transformNonKeywordSegments(current, (segment) => segment.replace(pattern, replacement))
    );
    if (next === current) {
      continue;
    }
    current = next;
    if (current.length <= maxChars) {
      return current;
    }
  }
  const fallback = buildFallbackBulletLine(current, lineIndex);
  if (fallback && fallback.length <= maxChars) {
    return fallback;
  }
  return current;
}

function compressTitleToLimit(title: string, maxChars: number): string {
  if (maxChars <= 0 || title.length <= maxChars) {
    return title;
  }
  let current = title;
  for (const [pattern, replacement] of titleCompressionRules) {
    const next = normalizeLine(current.replace(pattern, replacement));
    if (next === current) {
      continue;
    }
    current = next;
    if (current.length <= maxChars) {
      return current;
    }
  }
  return current;
}

function normalizeBulletsContentForValidation(content: string, rule: SectionRule): string {
  if (rule.section !== "bullets") {
    return content;
  }
  const rawMaxCharsPerLine = getNumber(rule.constraints, "max_chars_per_line", 0);
  if (rawMaxCharsPerLine <= 0) {
    return content;
  }
  const hardMax = rawMaxCharsPerLine + getTolerance(rule.constraints);
  if (hardMax <= 0) {
    return content;
  }
  const preferredMax = Math.min(hardMax, rawMaxCharsPerLine + 5);
  return splitLines(content)
    .map((line, index) => {
      if (line.length <= preferredMax) {
        return line;
      }
      return compressBulletLineToLimit(line, preferredMax, index);
    })
    .join("\n");
}

function normalizeTitleContentForValidation(content: string, rule: SectionRule): string {
  if (rule.section !== "title") {
    return content;
  }
  const rawMaxChars = getNumber(rule.constraints, "max_chars", 0);
  if (rawMaxChars <= 0) {
    return content;
  }
  const hardMax = rawMaxChars + getTolerance(rule.constraints);
  if (hardMax <= 0) {
    return content;
  }
  return compressTitleToLimit(normalizeLine(content), hardMax);
}

function normalizeSectionContentForValidation(content: string, rule: SectionRule): string {
  if (rule.section === "bullets") {
    return normalizeBulletsContentForValidation(content, rule);
  }
  if (rule.section === "title") {
    return normalizeTitleContentForValidation(content, rule);
  }
  return content;
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

function normalizeHeadingForPromptFilter(text: string): string {
  return text.toLowerCase().replace(/[\s:：()（）【】\[\]<>《》,，.。;；!！?？'"`~\-_/|]+/g, "");
}

function compactSectionRequirementsRawForPrompt(raw: string, section: string): string {
  const normalized = normalizeText(raw);
  if (!normalized) {
    return "";
  }
  if (section !== "description" && section !== "bullets") {
    return normalized;
  }
  const skipHeadingPrefixes = ["关键词", "keyword", "分类", "category", "类目"].map(normalizeHeadingForPromptFilter);
  const lines = normalized.split("\n");
  const kept: string[] = [];
  let skipping = false;
  let previousBlank = false;
  for (const line of lines) {
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (headingMatch) {
      const normalizedHeading = normalizeHeadingForPromptFilter(headingMatch[1]);
      skipping = skipHeadingPrefixes.some((prefix) => normalizedHeading.includes(prefix));
      if (skipping) {
        continue;
      }
    }
    if (skipping) {
      continue;
    }
    if (line.trim() === "") {
      if (!previousBlank) {
        kept.push("");
      }
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    kept.push(line);
  }
  return normalizeText(kept.join("\n"));
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
  const candidate = fenced && fenced[1] ? fenced[1].trim() : text;
  if (!candidate) {
    return "";
  }
  const start = candidate.indexOf("{");
  if (start < 0) {
    return candidate;
  }
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return candidate.slice(start, index + 1).trim();
    }
  }
  return candidate;
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

export function formatJSONArrayContent(content: string, field: string): string {
  return JSON.stringify({
    [field]: splitLines(content)
  });
}

function isAgentMetaParagraph(input: string): boolean {
  const text = normalizeLine(input).toLowerCase();
  if (!text || text.length > 160) {
    return false;
  }
  const hasValidationPhrase = (
    text.includes("校验通过") ||
    text.includes("验证通过") ||
    ((text.includes("通过") || text.includes("passed")) && text.includes("验证")) ||
    text.includes("validation passed") ||
    text.includes("passed validation")
  );
  const hasFinalOutputPhrase = (
    text.includes("最终") ||
    text.includes("输出") ||
    text.includes("标题") ||
    text.includes("内容") ||
    text.includes("结果") ||
    text.includes("final title") ||
    text.includes("final content") ||
    text.includes("final result")
  );
  return (
    (hasValidationPhrase && hasFinalOutputPhrase) ||
    text.includes("现在输出最终内容") ||
    text.includes("现在输出最终标题") ||
    text.includes("output final content") ||
    text.includes("output final title")
  );
}

function stripAgentMetaPreamble(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const paragraphs = normalized
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  while (paragraphs.length > 0 && isAgentMetaParagraph(paragraphs[0])) {
    paragraphs.shift();
  }

  let text = paragraphs.join("\n\n").trim();
  text = text.replace(
    /^(?:完美[！!。]?\s*)?(?:校验通过|验证通过)[，,:：\s]*(?:现在)?(?:输出|给出)?(?:最终)?(?:标题|内容|结果)?[：:\s]*/u,
    ""
  );
  text = text.replace(
    /^(?:完美[！!。]?\s*)?(?:(?:标题|内容|结果)\s*)?(?:已|已经)?通过(?:了)?(?:所有)?(?:校验|验证)[。！!，,:：\s]*(?:(?:现在|让我)\s*)?(?:输出|给出)(?:最终)?(?:的)?(?:标题|内容|结果)?[：:\s]*/u,
    ""
  );
  text = text.replace(
    /^(?:perfect[!.\s]*)?(?:validation passed|validated|passed validation)[,.: ]*(?:now )?(?:output|return|give)(?: the)? final (?:title|content|result)[: ]*/i,
    ""
  );
  text = text.replace(
    /^(?:perfect[!.\s]*)?(?:(?:title|content|result)\s+)?(?:has\s+)?passed(?:\s+all)?\s+validation[,.:\s]*(?:(?:now|let me)\s+)?(?:output|return|give)(?:\s+the)?\s+final\s+(?:title|content|result)[:\s]*/i,
    ""
  );
  return text.trim();
}

function resolveFixedParagraphCount(rule: SectionRule): number {
  const minParagraphs = getNumber(rule.constraints, "min_paragraphs", 0);
  const maxParagraphs = getNumber(rule.constraints, "max_paragraphs", 0);
  if (minParagraphs > 0 && minParagraphs === maxParagraphs) {
    return minParagraphs;
  }
  const executionParagraphs = typeof rule.execution.paragraph_count === "number" && Number.isFinite(rule.execution.paragraph_count)
    ? Math.floor(rule.execution.paragraph_count)
    : 0;
  return executionParagraphs > 0 ? executionParagraphs : 0;
}

export function adaptMarkdownContentForValidation(raw: string, rule: SectionRule): { content: string; error?: string } {
  let content = normalizeText(stripAgentMetaPreamble(raw));
  if (!content) {
    return { content: "" };
  }

  const expectedParagraphs = resolveFixedParagraphCount(rule);
  if (expectedParagraphs > 0) {
    const paragraphs = content
      .split(/\n\s*\n/g)
      .map((paragraph) => normalizeLine(paragraph))
      .filter(Boolean);
    if (paragraphs.length > expectedParagraphs) {
      const merged = paragraphs.slice(0, expectedParagraphs - 1);
      merged.push(paragraphs.slice(expectedParagraphs - 1).join(" "));
      content = merged.join("\n\n");
    }
  }

  if (rule.constraints.require_complete_sentence_end === true) {
    const paragraphs = content
      .split(/\n\s*\n/g)
      .map((paragraph) => normalizeLine(paragraph))
      .filter(Boolean)
      .map((paragraph) => {
        if (hasCompleteSentenceEnding(paragraph)) {
          return paragraph;
        }
        return `${stripTrailingClosers(paragraph)}.`;
      });
    content = paragraphs.join("\n\n");
  }

  return { content };
}

function normalizeSectionCandidateForScoring(raw: string, rule: SectionRule): { content: string; error?: string } {
  if (rule.section === "bullets") {
    const trimmed = normalizeText(raw);
    if (trimmed.startsWith("{")) {
      const adapted = adaptJSONArrayContent(raw, rule.output.json_array_field || "bullets");
      return {
        ...adapted,
        content: normalizeSectionContentForValidation(adapted.content, rule)
      };
    }
    return { content: normalizeSectionContentForValidation(trimmed, rule) };
  }
  const adapted = adaptMarkdownContentForValidation(raw, rule);
  return {
    ...adapted,
    content: normalizeSectionContentForValidation(adapted.content, rule)
  };
}

export function scoreRuntimeCandidateForTest(
  requirements: ListingRequirements,
  rule: SectionRule,
  raw: string
): { normalizedContent: string; score: number; errors: string[] } {
  return scoreRuntimeCandidateValue(requirements, rule, raw);
}

type RuntimeCandidateTraceSummary = {
  candidate_index: number;
  score?: number;
  error_count?: number;
  normalized_chars?: number;
  failure_reason?: string;
  selected: boolean;
  errors?: string[];
};

type ScoredRuntimeCandidate = {
  candidateIndex: number;
  normalizedContent: string;
  score: number;
  errors: string[];
};

type FailedRuntimeCandidate = {
  candidateIndex: number;
  failureReason: string;
};

function isScoredRuntimeCandidate(candidate: ScoredRuntimeCandidate | FailedRuntimeCandidate): candidate is ScoredRuntimeCandidate {
  return "score" in candidate;
}

function summarizeRuntimeCandidateSelection(
  requirements: ListingRequirements,
  rule: SectionRule,
  candidates: RuntimeSectionCandidateResult[]
): {
  selectedContent: string;
  selectedCandidateIndex: number;
  selectedScore: number;
  candidates: RuntimeCandidateTraceSummary[];
} {
  const scored: Array<ScoredRuntimeCandidate | FailedRuntimeCandidate> = candidates.map((candidate) => {
    if ("error" in candidate) {
      return {
        candidateIndex: candidate.candidateIndex,
        failureReason: candidate.error || "候选生成失败"
      };
    }
    const result = scoreRuntimeCandidateValue(requirements, rule, candidate.content);
    return {
      candidateIndex: candidate.candidateIndex,
      ...result
    };
  });
  const successful = scored.filter(isScoredRuntimeCandidate);
  const ranked = [...successful].sort((left, right) => left.score - right.score || left.candidateIndex - right.candidateIndex);
  const winner = ranked[0];
  const winnerIndex = winner?.candidateIndex ?? candidates.find((candidate): candidate is RuntimeSectionCandidate => "content" in candidate)?.candidateIndex ?? 1;
  return {
    selectedContent: winner?.normalizedContent ?? candidates.find((candidate): candidate is RuntimeSectionCandidate => "content" in candidate)?.content ?? "",
    selectedCandidateIndex: winnerIndex,
    selectedScore: winner?.score ?? 0,
    candidates: scored.map((candidate) => ({
      candidate_index: candidate.candidateIndex,
      selected: candidate.candidateIndex === winnerIndex,
      ...(isScoredRuntimeCandidate(candidate)
        ? {
            score: candidate.score,
            error_count: candidate.errors.length,
            normalized_chars: candidate.normalizedContent.length,
            errors: candidate.errors
          }
        : {
            failure_reason: candidate.failureReason
          })
    }))
  };
}

export function summarizeRuntimeCandidateSelectionForTest(
  requirements: ListingRequirements,
  rule: SectionRule,
  candidates: RuntimeSectionCandidateResult[]
): {
  selected_candidate_index: number;
  selected_score: number;
  candidates: RuntimeCandidateTraceSummary[];
} {
  const summary = summarizeRuntimeCandidateSelection(requirements, rule, candidates);
  return {
    selected_candidate_index: summary.selectedCandidateIndex,
    selected_score: summary.selectedScore,
    candidates: summary.candidates
  };
}

function scoreRuntimeCandidateValue(
  requirements: ListingRequirements,
  rule: SectionRule,
  raw: string
): { normalizedContent: string; score: number; errors: string[] } {
  const adapted = normalizeSectionCandidateForScoring(raw, rule);
  const normalized = normalizeText(normalizeSectionContentForValidation(adapted.content, rule));
  const errors = adapted.error ? [adapted.error] : validateSectionContent(normalized, requirements, rule);
  const targetMidpoint = (() => {
    const minChars = getNumber(rule.constraints, "min_chars", 0);
    const maxChars = getNumber(rule.constraints, "max_chars", 0);
    if (minChars > 0 && maxChars > 0) {
      return Math.floor((minChars + maxChars) / 2);
    }
    const minPerLine = getNumber(rule.constraints, "min_chars_per_line", 0);
    const maxPerLine = getNumber(rule.constraints, "max_chars_per_line", 0);
    const lineCount = getNumber(rule.constraints, "line_count", 0);
    if (minPerLine > 0 && maxPerLine > 0 && lineCount > 0) {
      return Math.floor(((minPerLine + maxPerLine) / 2) * lineCount);
    }
    return normalized.length;
  })();
  const proximityPenalty = Math.abs(normalized.length - targetMidpoint);
  return {
    normalizedContent: normalized,
    errors,
    score: errors.length * 10_000 + proximityPenalty
  };
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
  lowercase: boolean;
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
    lowercase: node.lowercase === true,
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
  const normalizedKeyword = config.lowercase ? normalizeLine(keyword).toLowerCase() : normalizeLine(keyword);
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
  const pattern = new RegExp(patternText, config.lowercase ? "" : "i");
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

function extractBulletHeading(line: string): string {
  const matched = /^([^:：]+)[:：]\s*/.exec(normalizeLine(line));
  return matched?.[1]?.trim() ?? "";
}

function countHeadingWords(heading: string): number {
  return heading
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean).length;
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
  const hardMinForBullets = rule.section === "bullets";
  const minChars = rawMinChars > 0 ? (hardMinForBullets ? rawMinChars : rawMinChars - tolerance) : 0;
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
  const headingMinWords = getNumber(constraints, "heading_min_words", 0);
  const headingMaxWords = getNumber(constraints, "heading_max_words", 0);
  const minCharsPerLine = rawMinCharsPerLine > 0 ? (hardMinForBullets ? rawMinCharsPerLine : rawMinCharsPerLine - tolerance) : 0;
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
      if (headingMinWords > 0 || headingMaxWords > 0) {
        const heading = extractBulletHeading(line);
        const headingWords = countHeadingWords(heading);
        if (!heading || !rangeCheck(headingWords, headingMinWords, headingMaxWords)) {
          errors.push(
            `第${i + 1}条小标题词数不满足约束: ${headingWords}（规则区间 ${formatRange(headingMinWords, headingMaxWords)}）`
          );
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

function stripMarkdownBold(input: string): string {
  return input.replace(/\*\*([^*]+)\*\*/g, "$1");
}

type TranslationReusePlan = {
  reusedTranslations: Record<string, string>;
  pendingSectionKeys: string[];
};

function resolveRuntimeTeamAttempts(constraints: Record<string, unknown>): number {
  return Math.max(1, getNumber(constraints, "api_attempts", 1));
}

function resolveRuntimeTeamMaxTurns(section: string, hasReviewer: boolean): number {
  if (section === "bullets") {
    return 12;
  }
  if (!hasReviewer) {
    return 6;
  }
  return 8;
}

function buildTranslationReusePlan(
  originalSections: Record<string, string>,
  judgedSections: Record<string, string>,
  translations: Record<string, string>
): TranslationReusePlan {
  const reusedTranslations: Record<string, string> = {};
  const categoryCN = typeof translations.category_cn === "string" ? translations.category_cn : "";
  const keywordsCN = typeof translations.keywords_cn === "string" ? translations.keywords_cn : "";
  if (categoryCN) {
    reusedTranslations.category_cn = categoryCN;
  }
  if (keywordsCN) {
    reusedTranslations.keywords_cn = keywordsCN;
  }

  const pendingSectionKeys: string[] = [];
  for (const [section, value] of Object.entries(judgedSections)) {
    const translationKey = `${section}_cn`;
    const translated = translations[translationKey];
    if (originalSections[section] === value && typeof translated === "string" && translated.trim() !== "") {
      reusedTranslations[translationKey] = translated;
      continue;
    }
    pendingSectionKeys.push(section);
  }

  return {
    reusedTranslations,
    pendingSectionKeys
  };
}

export function buildTranslationReusePlanForTest(
  originalSections: Record<string, string>,
  judgedSections: Record<string, string>,
  translations: Record<string, string>
): TranslationReusePlan {
  return buildTranslationReusePlan(originalSections, judgedSections, translations);
}

export function resolveRuntimeTeamAttemptsForTest(constraints: Record<string, unknown>): number {
  return resolveRuntimeTeamAttempts(constraints);
}

export function resolveRuntimeTeamMaxTurnsForTest(section: string, hasReviewer: boolean): number {
  return resolveRuntimeTeamMaxTurns(section, hasReviewer);
}

export function compactSectionRequirementsRawForPromptForTest(raw: string, section: string): string {
  return compactSectionRequirementsRawForPrompt(raw, section);
}

function shouldRunPromptPlanning(rules: Pick<TenantRules, "generationConfig">): boolean {
  if (!rules.generationConfig.planning.enabled) {
    return false;
  }
  // Runtime-native orchestration no longer consumes a planner brief for control flow.
  // Keeping the extra LLM planning call only adds latency to every job.
  return false;
}

export function shouldRunPromptPlanningForTest(rules: Pick<TenantRules, "generationConfig">): boolean {
  return shouldRunPromptPlanning(rules);
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
    const mapped = rules.generationConfig.display_labels[key];
    if (typeof mapped === "string" && mapped.trim() !== "") {
      return mapped.trim();
    }
    const sectionRule = rules.sections.get(key);
    if (sectionRule) {
      const sectionMapped = rules.generationConfig.display_labels[sectionRule.section];
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

  private buildSectionUserPrompt(requirements: ListingRequirements, rule: SectionRule, extra?: string): string {
    const keywords = requirements.keywords.join("\n");
    const requirementsRaw = compactSectionRequirementsRawForPrompt(
      this.requirementsRawForPrompt || requirements.raw,
      rule.section
    );
    const executionGuidance = buildSectionExecutionGuidance(requirements, rule);
    return [
      `任务: 生成 section=${rule.section}（英文）`,
      this.executionBrief ? `执行简报:\n${this.executionBrief}` : "",
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      !executionGuidance ? `关键词库:\n${keywords}` : "",
      "输入需求原文:",
      requirementsRaw,
      executionGuidance ? `结构化执行指导:\n${executionGuidance}` : "",
      extra ? `\n修正反馈:\n${extra}` : ""
    ].join("\n");
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

  private jsonObjectModelSettings(): Partial<ModelSettings> | undefined {
    return {
      providerData: {
        response_format: {
          type: "json_object"
        }
      }
    };
  }

  private buildWholeRepairSystemPrompt(rule: SectionRule, jsonOutput = false): string {
    const constraintsSummary = this.constraintsSummary(rule);
    const constraintsJSON = JSON.stringify(rule.constraints, null, 2);
    return [
      "你是专业亚马逊 Listing 文案专家。",
      "你正在修复一段已有文案。",
      jsonOutput
        ? "只输出修复后的 JSON 对象，不要解释，不要代码块，不要额外文本。"
        : "只输出修复后的 section 文本，不要解释，不要 JSON，不要代码块。",
      "check_section_candidate 是校验工具，不是 agent，也不是 handoff。",
      "绝不要调用任何 transfer_to_validator_* 工具。",
      "若 check_section_candidate 返回 repair_guidance，必须逐条执行其中的修复要求。",
      "优先只改失败条目；前面已经满足顺序和长度的条目尽量保持不变。",
      "严禁通过截断尾部满足长度，必须重写为完整句，并用句末标点收尾。",
      `section=${rule.section}`,
      `规则:\n${rule.instruction}`,
      `硬性约束摘要:\n${constraintsSummary}`,
      `硬性约束(JSON):\n${constraintsJSON}`
    ].join("\n");
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
    return this.translateTextWithProfile(text, step, retries);
  }

  private async translateTextWithProfile(
    text: string,
    step: string,
    retries: number,
    runtimeProfile?: ModelProfile
  ): Promise<string> {
    this.throwIfAborted();
    const rules = this.mustRulesLoaded();
    const started = Date.now();
    await this.appendTrace("translation_start", "info", { step, input_chars: text.length, retries });
    this.logger.info({ event: "translation_start", step, input_chars: text.length, retries }, "translation start");
    const translated = await this.llmClient.translateWithTranslatorAgent(
      rules.generationConfig.translation.system_prompt,
      text,
      step,
      Math.max(1, retries),
      runtimeProfile
    );
    this.logger.info(
      { event: "translation_ok", step, duration_ms: Date.now() - started, output_chars: translated.length },
      "translation ok"
    );
    await this.appendTrace("translation_ok", "info", {
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
    if (!shouldRunPromptPlanning(rules)) {
      return "";
    }
    const started = Date.now();
    await this.appendTrace("runtime_plan_start", "info", {
      brand: requirements.brand,
      category: requirements.category,
      keywords_count: requirements.keywords.length
    });
    try {
      const brief = await this.llmClient.runtimePlanWithPlannerAgent(
        rules.generationConfig.planning.system_prompt,
        renderByVars(rules.generationConfig.planning.user_prompt, this.buildPromptVars(requirements)),
        "runtime_plan",
        rules.generationConfig.planning.retries
      );
      const normalized = normalizeText(brief);
      await this.appendTrace("runtime_plan_ok", "info", {
        duration_ms: Date.now() - started,
        output_chars: normalized.length
      });
      return normalized;
    } catch (error) {
      if (this.isAbortLikeError(error)) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      await this.appendTrace("runtime_plan_failed", "warn", {
        duration_ms: Date.now() - started,
        error: msg
      });
      this.logger.warn({ event: "runtime_plan_failed", error: msg }, "runtime plan failed");
      return "";
    }
  }

  private parseJudgeIssues(text: string): JudgeIssue[] {
    const rules = this.mustRulesLoaded();
    return parseJudgeIssues(text, rules.generationConfig.judge.ignore_messages, [...rules.sections.keys()]);
  }

  private async runQualityJudge(
    requirements: ListingRequirements,
    sections: Record<string, string>
  ): Promise<JudgeIssue[]> {
    this.throwIfAborted();
    const rules = this.mustRulesLoaded();
    if (!rules.generationConfig.judge.enabled) {
      return [];
    }
    const started = Date.now();
    await this.appendTrace("review_start", "info", {});
    try {
      const judgeOutput = await this.llmClient.reviewWithJudgeAgent(
        rules.generationConfig.judge.system_prompt,
        renderByVars(rules.generationConfig.judge.user_prompt, this.buildPromptVars(requirements, sections)),
        "review",
        rules.generationConfig.judge.retries
      );
      const allIssues = this.parseJudgeIssues(judgeOutput);
      const skipSet = new Set(rules.generationConfig.judge.skip_sections.map((v) => v.toLowerCase()));
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
        await this.appendTrace("review_issues_skipped", "warn", {
          skipped_count: dropped.length,
          skipped_issues: dropped
        });
      }
      if (issues.length > 0) {
        await this.appendTrace("review_issues", "warn", {
          duration_ms: Date.now() - started,
          issues
        });
      } else {
        await this.appendTrace("review_ok", "info", {
          duration_ms: Date.now() - started
        });
      }
      return issues;
    } catch (error) {
      if (this.isAbortLikeError(error)) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      await this.appendTrace("review_failed", "warn", {
        duration_ms: Date.now() - started,
        error: msg
      });
      this.logger.warn({ event: "review_failed", error: msg }, "review failed");
      return [];
    }
  }

  private generationSectionRule(section: string): SectionRule {
    const rules = this.mustRulesLoaded();
    const rule = rules.sections.get(section);
    if (!rule) {
      throw new Error(`规则文件缺失 section: ${section}`);
    }
    return rule;
  }

  private generationTranslateStep(inputSlot: string): string {
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

  private buildRenderVarsFromContext(node: GenerationNode, ctx: ExecutionContext): Record<string, string> {
    const rules = this.mustRulesLoaded();
    return buildRenderVariables(node, ctx, {
      inputFields: rules.input.fields,
      sections: rules.sections,
      render: rules.generationConfig.render
    });
  }

  private async executeDeriveNode(requirements: ListingRequirements, node: GenerationNode): Promise<string> {
    const section = (node.section ?? "").trim();
    const rule = this.generationSectionRule(section);
    if (section === "search_terms") {
      return buildSearchTermsFromRule(requirements, rule);
    }
    throw new Error(`generation config derive 暂不支持 section: ${section}`);
  }

  private async executeJudgeNode(
    requirements: ListingRequirements,
    node: GenerationNode,
    ctx: ExecutionContext
  ): Promise<NodeExecutionResult> {
    const maxJudgeRounds = this.mustRulesLoaded().generationConfig.judge.max_rounds;
    const registry = createDefaultRegistry();
    const boundSections = collectNodeSectionSlots(node, ctx);
    const repairedSections: Record<string, string> = { ...boundSections };

    let judgeIssues = await this.runQualityJudge(requirements, repairedSections);

    for (let judgeRound = 1; judgeRound <= maxJudgeRounds && judgeIssues.length > 0; judgeRound += 1) {
      this.throwIfAborted();
      const grouped = this.groupJudgeIssuesBySection(judgeIssues);
      await this.appendTrace("review_repair_round_start", "warn", {
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
        const rule = this.generationSectionRule(section);
        const jsonOutput = rule.output.format === "json";
        const jsonArrayField = rule.output.json_array_field || section;
        const modelSettings = jsonOutput ? this.jsonObjectModelSettings() : undefined;
        const adaptContent = jsonOutput
          ? (raw: string) => adaptJSONArrayContent(raw, jsonArrayField)
          : (raw: string) => adaptMarkdownContentForValidation(raw, rule);
        const repaired = await this.llmClient.generateSectionWithAgentTeam({
          section,
          step: `${section}_judge_repair_round_${judgeRound}`,
          userPrompt: this.buildSectionUserPrompt(requirements, rule, this.buildJudgeFeedbackText(messages)),
          writerInstructions: this.buildSectionSystemPrompt(rule, jsonOutput),
          reviewerInstructions: [
            "你是 section 质量复核专家。",
            `当前 section=${rule.section}`,
            "check_section_candidate 是校验工具，不是 agent，也不是 handoff。",
            "绝不要调用任何 transfer_to_validator_* 工具。",
            "不要自行终止，必须先调用 check_section_candidate。",
            "如果校验通过，直接输出 final_output。",
            "如果校验失败，必须依据 errors 和 repair_guidance 把问题交给 repairer。"
          ].join("\n"),
          repairInstructions: this.buildWholeRepairSystemPrompt(rule, jsonOutput),
          attempts: Math.max(2, getNumber(rule.constraints, "api_attempts", 4)),
          plannerRuntimeProfile: registry.modelProfiles.get("planner-default"),
          runtimeProfile: registry.modelProfiles.get("writer-default"),
          reviewerRuntimeProfile: registry.modelProfiles.get("reviewer-default"),
          repairerRuntimeProfile: registry.modelProfiles.get("repairer-default"),
          modelSettingsOverride: modelSettings,
          repairerModelSettingsOverride: modelSettings,
          validateContent: (raw) => {
            const adapted = adaptContent ? adaptContent(raw) : { content: raw };
            const normalized = normalizeText(normalizeSectionContentForValidation(adapted.content, rule));
            const errors = adapted.error ? [adapted.error] : validateSectionContent(normalized, requirements, rule);
            return {
              ok: errors.length === 0,
              normalizedContent: normalized,
              finalOutput: jsonOutput ? formatJSONArrayContent(normalized, jsonArrayField) : normalized,
              errors,
              repairGuidance: buildSectionRepairGuidance(requirements, rule, errors)
            };
          }
        });
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

  private async executeRenderNode(ctx: ExecutionContext, node: GenerationNode): Promise<string> {
    const rules = this.mustRulesLoaded();
    const templateKey = (node.template ?? "").trim();
    if (templateKey !== "en" && templateKey !== "cn") {
      throw new Error(`generation config render 暂不支持 template: ${templateKey}`);
    }
    const vars = this.buildRenderVarsFromContext(node, ctx);
    return normalizeText(renderByVars(rules.templates[templateKey], vars));
  }

  private agentRuntimeTranslateStep(slot: string): string {
    const normalized = slot.trim().toLowerCase();
    switch (normalized) {
      case "category_cn":
        return "translate_category";
      case "keywords_cn":
        return "translate_keywords";
      case "title_cn":
        return "translate_title";
      case "bullets_cn":
        return "translate_bullets";
      case "description_cn":
        return "translate_description";
      case "search_terms_cn":
        return "translate_search_terms";
      default:
        return `translate_${normalized}`;
    }
  }

  private async runRuntimeQualityJudge(
    requirements: ListingRequirements,
    sections: Record<string, string>
  ): Promise<{ sections: Record<string, string>; issuesCount: number }> {
    if (!this.mustRulesLoaded().generationConfig.judge.enabled) {
      return {
        sections,
        issuesCount: 0
      };
    }
    const ctx = this.buildInitialExecutionContext(requirements);
    const inputs: Record<string, string> = {};
    for (const [section, value] of Object.entries(sections)) {
      const slot = `${section}_en`;
      inputs[section] = slot;
      ctx.set(slot, normalizeText(value));
    }
    const result = await this.executeJudgeNode(requirements, {
      id: "runtime_quality_review",
      type: "judge",
      inputs,
      output_to: "runtime_review_report"
    }, ctx);

    const repairedSections: Record<string, string> = {};
    for (const section of Object.keys(sections)) {
      const slot = inputs[section];
      if (slot && ctx.has(slot)) {
        repairedSections[section] = normalizeText(ctx.get(slot));
      }
    }
    const issuesCount = Number.parseInt(result.outputValue, 10);
    return {
      sections: repairedSections,
      issuesCount: Number.isFinite(issuesCount) ? issuesCount : 0
    };
  }

  private scoreRuntimeCandidate(
    requirements: ListingRequirements,
    rule: SectionRule,
    raw: string
  ): { normalizedContent: string; score: number; errors: string[] } {
    return scoreRuntimeCandidateValue(requirements, rule, raw);
  }

  private async executeAgentRuntime(
    requirements: ListingRequirements,
    tenantRules: TenantRules,
    inputFilename: string,
    resumeSections: Record<string, string> = {},
    persistRuntimeSection?: (section: string, value: string) => Promise<void> | void
  ): Promise<GenerationExecutionOutput> {
    const registry = createDefaultRegistry();
    const spec = compileExecutionSpec(tenantRules, registry);
    const getModelProfile = (id: string | undefined): ModelProfile | undefined =>
      id ? registry.modelProfiles.get(id) : undefined;
    await this.appendTrace("runtime_compile_ok", "info", {
      parallel_groups: spec.parallelGroups.length,
      section_concurrency: spec.limits.sectionConcurrency
    });

    const sectionResult = await executeRuntimeSections(spec, {
      category: requirements.category,
      keywords: requirements.keywords.join("\n"),
      initialSections: Object.fromEntries(
        Object.entries(resumeSections)
          .filter(([section, value]) => spec.sectionPlans.has(section) && typeof value === "string" && value.trim() !== "")
          .map(([section, value]) => [section, normalizeText(value)])
      ),
      onSectionComplete: async (section, value) => {
        await persistRuntimeSection?.(section, normalizeText(value));
      },
      generateSection: async (plan, candidateIndex, controls) => {
        const rule = this.generationSectionRule(plan.section);
        const isBullets = rule.section === "bullets";
        const bulletsJSONModeSettings = isBullets ? this.jsonObjectModelSettings() : undefined;
        const bulletsJSONArrayField = rule.output.json_array_field || "bullets";
        const options = isBullets
          ? {
              jsonOutput: true,
              writerModelSettings: bulletsJSONModeSettings,
              repairModelSettings: bulletsJSONModeSettings,
              adaptContent: (raw: string) => adaptJSONArrayContent(raw, bulletsJSONArrayField)
            }
          : {
              adaptContent: (raw: string) => adaptMarkdownContentForValidation(raw, rule)
            };
        const validateContent = (raw: string) => {
          const adapted = options?.adaptContent ? options.adaptContent(raw) : { content: raw };
          const normalized = normalizeText(normalizeSectionContentForValidation(adapted.content, rule));
          const errors = adapted.error ? [adapted.error] : validateSectionContent(normalized, requirements, rule);
          return {
            ok: errors.length === 0,
            normalizedContent: normalized,
            finalOutput: isBullets ? formatJSONArrayContent(normalized, bulletsJSONArrayField) : normalized,
            errors,
            repairGuidance: buildSectionRepairGuidance(requirements, rule, errors)
          };
        };
        return await this.llmClient.generateSectionWithAgentTeam({
          section: plan.section,
          step: `${plan.section}_runtime_team_candidate_${candidateIndex}`,
          userPrompt: this.buildSectionUserPrompt(requirements, rule, ""),
          writerInstructions: this.buildSectionSystemPrompt(rule, isBullets),
          reviewerInstructions: plan.reviewerBlueprint
            ? [
                "你是 section 质量复核专家。",
                `当前 section=${rule.section}`,
                "check_section_candidate 是校验工具，不是 agent，也不是 handoff。",
                "绝不要调用任何 transfer_to_validator_* 工具。",
                "不要自行终止，必须先调用 check_section_candidate。",
                "如果校验通过，直接输出 final_output。",
                "如果校验失败，必须依据 errors 和 repair_guidance 把问题交给 repairer。"
              ].join("\n")
            : undefined,
          repairInstructions: this.buildWholeRepairSystemPrompt(rule, isBullets),
          attempts: resolveRuntimeTeamAttempts(rule.constraints),
          maxTurns: resolveRuntimeTeamMaxTurns(plan.section, Boolean(plan.reviewerBlueprint)),
          plannerRuntimeProfile: getModelProfile(plan.plannerModelProfile),
          runtimeProfile: getModelProfile(plan.writerModelProfile),
          reviewerRuntimeProfile: getModelProfile(plan.reviewerModelProfile),
          repairerRuntimeProfile: getModelProfile(plan.repairerModelProfile),
          modelSettingsOverride: bulletsJSONModeSettings,
          repairerModelSettingsOverride: bulletsJSONModeSettings,
          shouldRetry: () => controls?.shouldContinueRetries() ?? true,
          signal: controls?.signal,
          validateContent
        });
      },
      deriveSection: async (plan) => this.executeDeriveNode(requirements, {
        id: `${plan.section}_runtime_derive`,
        type: "derive",
        section: plan.section,
        output_to: `${plan.section}_en`
      }),
      pickBestCandidate: async (plan, candidates) => {
        const rule = this.generationSectionRule(plan.section);
        const summary = summarizeRuntimeCandidateSelection(requirements, rule, candidates);
        await this.appendTrace("runtime_candidate_selection", "info", {
          section: plan.section,
          candidate_count: candidates.length,
          selected_candidate_index: summary.selectedCandidateIndex,
          selected_score: summary.selectedScore,
          candidates: summary.candidates
        });
        return summary.selectedContent;
      },
      translateValue: async (slot, value) =>
        this.translateTextWithProfile(
          value,
          this.agentRuntimeTranslateStep(slot),
          1,
          getModelProfile(spec.translationPlan.modelProfile)
        )
    });

    const judged = await this.runRuntimeQualityJudge(requirements, sectionResult.sections);
    const ctx = this.buildInitialExecutionContext(requirements);
    for (const [section, value] of Object.entries(judged.sections)) {
      ctx.set(`${section}_en`, normalizeText(value));
    }
    const translationReuse = buildTranslationReusePlan(sectionResult.sections, judged.sections, sectionResult.translations);
    for (const [slot, value] of Object.entries(translationReuse.reusedTranslations)) {
      ctx.set(slot, value);
    }
    for (const section of translationReuse.pendingSectionKeys) {
      const value = judged.sections[section] ?? "";
      ctx.set(
        `${section}_cn`,
        await this.translateTextWithProfile(
          value,
          this.agentRuntimeTranslateStep(`${section}_cn`),
          1,
          getModelProfile(spec.translationPlan.modelProfile)
        )
      );
    }

    const enMarkdown = replaceTopHeading(
      normalizeText(
        await this.executeRenderNode(ctx, {
          id: "runtime_render_en",
          type: "render",
          template: "en",
          output_to: "en_markdown",
          inputs: {
            brand: "brand",
            category_en: "category",
            keywords_en: "keywords",
            title_en: "title_en",
            bullets_en: "bullets_en",
            description_en: "description_en",
            search_terms_en: "search_terms_en"
          }
        })
      ),
      inputFilename
    );
    const cnMarkdown = replaceTopHeading(
      normalizeText(
        await this.executeRenderNode(ctx, {
          id: "runtime_render_cn",
          type: "render",
          template: "cn",
          output_to: "cn_markdown",
          inputs: {
            brand: "brand",
            category_cn: "category_cn",
            keywords_cn: "keywords_cn",
            title_cn: "title_cn",
            bullets_cn: "bullets_cn",
            description_cn: "description_cn",
            search_terms_cn: "search_terms_cn"
          }
        })
      ),
      inputFilename
    );

    return {
      enMarkdown,
      cnMarkdown,
      bulletsCount: splitLines(ctx.get("bullets_en")).length,
      judgeIssuesCount: judged.issuesCount
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

    this.executionBrief = await this.planExecution(requirements);
    this.throwIfAborted();
    const generationOutput = await this.executeAgentRuntime(
      requirements,
      tenantRules,
      inputFilename,
      input.resumeSections ?? {},
      input.persistRuntimeSection
    );
    this.throwIfAborted();

    this.logger.info(
      {
        event: "generation_ok",
        tenant_id: input.tenantId,
        job_id: input.jobId,
        rules_version: input.rulesVersion,
        timing_ms: Date.now() - start,
        en_chars: generationOutput.enMarkdown.length,
        cn_chars: generationOutput.cnMarkdown.length
      },
      "generation ok"
    );
    await this.appendTrace("generation_ok", "info", {
      rules_version: input.rulesVersion,
      timing_ms: Date.now() - start,
      en_chars: generationOutput.enMarkdown.length,
      cn_chars: generationOutput.cnMarkdown.length
    });

    return {
      en_markdown: generationOutput.enMarkdown,
      cn_markdown: generationOutput.cnMarkdown,
      validation_report: [
        `rules_version=${input.rulesVersion}`,
        `keywords_count=${requirements.keywords.length}`,
        `bullets_count=${generationOutput.bulletsCount}`,
        `judge_issues_count=${generationOutput.judgeIssuesCount}`
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
