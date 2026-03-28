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
import { LLMClient, SectionAgentTeamValidationError } from "./llm-client.js";
import { inputMatchesMarker, parseRequirements, type ListingRequirements } from "./requirements-parser.js";
import { loadTenantRules, type SectionRule, type TenantRules } from "./rules-loader.js";
import { buildSectionExecutionGuidance, buildSectionKeywordPlan, buildSectionRepairGuidance } from "./section-guidance.js";
import type { RedisTraceStore } from "../store/trace-store.js";
import { ExecutionContext } from "../runtime-support/execution-context.js";
import type { GenerationNode } from "../runtime-support/types.js";
import { buildRenderVariables, collectNodeSectionSlots, parseJudgeIssues } from "../runtime-support/bindings.js";
import { VersionService } from "./version-service.js";

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

function countLengthForValidation(input: string): number {
  return input.replace(/\*\*/g, "").length;
}

function buildInputCharMetrics(input: string): { input_chars: number; raw_input_chars: number } {
  return {
    input_chars: countLengthForValidation(input),
    raw_input_chars: input.length
  };
}

function buildOutputCharMetrics(input: string): { output_chars: number; raw_output_chars: number } {
  return {
    output_chars: countLengthForValidation(input),
    raw_output_chars: input.length
  };
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

const descriptionCompressionRules: Array<[RegExp, string]> = [
  [/\bElevate any space with our versatile set of twelve\b/gi, "Set of twelve"],
  [/\bElevate your space with our versatile set of\b/gi, "Set of"],
  [/\bTransform your space with this versatile set of twelve\b/gi, "Set of twelve"],
  [/\bTransform any room with these essential\b/gi, "These"],
  [/\bperfect for creating a festive and personalized atmosphere\b/gi, "for festive displays"],
  [/\bperfect for all your\b/gi, "for"],
  [/\bfeaturing a vibrant plaid pattern\b/gi, "with plaid pattern"],
  [/\bwith a charming plaid design\b/gi, "with plaid design"],
  [/\bmeasuring 10x10 inches each for a substantial visual impact\b/gi, "in 10x10 inches"],
  [/\bideal as\b/gi, "as"],
  [/\bhelp classrooms,\s*parties,\s*and welcome walls feel bright and polished\b/gi, "fit classrooms and welcome walls"],
  [/\bThis pack is exceptionally suited for\b/gi, "This set suits"],
  [/\bproviding an engaging\b/gi, "with"],
  [/\bsolution for inspiring\b/gi, "for"],
  [/\bTheir playful plaid pattern enhances\b/gi, "Plaid styling fits"],
  [/\bperfect for stimulating learning environments\b/gi, "for classrooms"],
  [/\bthey also adapt beautifully for elegant\b/gi, "they also suit"],
  [/\bBeyond classrooms,\s*they serve as charming\b/gi, "Beyond classrooms, they suit"],
  [/\bor vibrant\b/gi, "or"],
  [/\bThe set also works as\b/gi, "The set works as"],
  [/\bin classrooms and party tables\b/gi, "for classrooms and party tables"],
  [/\ba bright plaid focal point for\b/gi, "plaid focus for"],
  [/\bbright plaid focal point for\b/gi, "plaid focus for"],
  [/\bkeeps displays cheerful and photo ready\b/gi, "keeps displays photo ready"],
  [/\bspread coordinated color through\b/gi, "spread color through"],
  [/\bteacher prepared\b/gi, ""],
  [/\bLightweight frames open quickly and fold flat after use\b/gi, "Frames open quickly and fold flat"],
  [/\bstay practical for repeated school decorating\b/gi, "work for repeated school decor"],
  [/\bwithout extra tools\b/gi, "fast"],
  [/\bneat,\s*colorful,\s*and easy to reset\b/gi, "neat and easy to reset"],
  [/\bcheerful\b/gi, ""],
  [/\bbright\b/gi, ""],
  [/\bcoordinated\b/gi, ""],
  [/\bseasonal\b/gi, ""],
  [/\bdaily\b/gi, ""],
  [/\brepeated\b/gi, ""],
  [/\bpractical\b/gi, ""],
  [/\bpolished\b/gi, ""],
  [/\bvisually\b/gi, ""],
  [/\bbusy\b/gi, ""],
  [/\bfrom every angle\b/gi, ""],
  [/\bagain\b/gi, ""],
  [/\ball season long\b/gi, "all term"],
  [/\ball term long\b/gi, "all term"]
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

function cleanupCompressedDescriptionContent(input: string): string {
  return normalizeText(
    input
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .split(/\n\s*\n/g)
      .map((paragraph) =>
        normalizeLine(
          paragraph
            .replace(/\s+([,.;!?])/g, "$1")
            .replace(/([,.;!?])([A-Za-z*])/g, "$1 $2")
            .replace(/([A-Za-z0-9])\*\*(?=[A-Za-z])/g, "$1** ")
            .replace(/\(\s+/g, "(")
            .replace(/\s+\)/g, ")")
        )
      )
      .filter(Boolean)
      .join("\n\n")
  );
}

function splitSentencesPreservePunctuation(input: string): string[] {
  const matches = input.match(/[^.!?]+[.!?]?/g);
  return matches ? matches.filter((item) => item.length > 0) : [input];
}

function pruneCommaClauseInSentence(
  sentence: string
): { sentence: string; saving: number } | null {
  const leading = sentence.match(/^\s*/)?.[0] ?? "";
  const trailing = sentence.match(/\s*$/)?.[0] ?? "";
  const trimmed = sentence.trim();
  if (!trimmed) {
    return null;
  }
  const punctuation = /[.!?]$/.test(trimmed) ? trimmed.slice(-1) : "";
  const core = punctuation ? trimmed.slice(0, -1).trim() : trimmed;
  const parts = core
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  let removeIndex = -1;
  let removeLength = 0;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const candidate = parts[index] ?? "";
    if (!candidate || /^and\b/i.test(candidate)) {
      continue;
    }
    if (candidate.length > removeLength) {
      removeIndex = index;
      removeLength = candidate.length;
    }
  }
  if (removeIndex < 0) {
    removeIndex = 1;
    removeLength = parts[1]?.length ?? 0;
  }
  if (removeLength <= 0) {
    return null;
  }
  const nextParts = parts.filter((_value, index) => index !== removeIndex);
  let rebuilt = nextParts.join(", ");
  rebuilt = rebuilt.replace(/,\s+(and|or)\b/gi, " $1");
  rebuilt = cleanupCompressedDescriptionContent(`${leading}${rebuilt}${punctuation}${trailing}`);
  const originalLength = countLengthForValidation(sentence);
  const nextLength = countLengthForValidation(rebuilt);
  if (nextLength >= originalLength) {
    return null;
  }
  return {
    sentence: rebuilt,
    saving: originalLength - nextLength
  };
}

function pruneDescriptionCommaClauseOnce(input: string, minChars = 0): string {
  const segments = input.split(/(\*\*[^*]+\*\*)/g);
  let bestSegmentIndex = -1;
  let bestSentenceIndex = -1;
  let bestReplacement = "";
  let bestSaving = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex] ?? "";
    if (!segment || (segment.startsWith("**") && segment.endsWith("**"))) {
      continue;
    }
    const sentences = splitSentencesPreservePunctuation(segment);
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const candidate = pruneCommaClauseInSentence(sentences[sentenceIndex] ?? "");
      if (!candidate || candidate.saving <= bestSaving) {
        continue;
      }
      const nextSentences = [...sentences];
      nextSentences[sentenceIndex] = candidate.sentence;
      const nextSegments = [...segments];
      nextSegments[segmentIndex] = nextSentences.join("");
      const nextContent = cleanupCompressedDescriptionContent(nextSegments.join(""));
      if (minChars > 0 && countLengthForValidation(nextContent) < minChars) {
        continue;
      }
      bestSegmentIndex = segmentIndex;
      bestSentenceIndex = sentenceIndex;
      bestReplacement = candidate.sentence;
      bestSaving = candidate.saving;
    }
  }

  if (bestSegmentIndex < 0 || bestSentenceIndex < 0) {
    return input;
  }

  const targetSegment = segments[bestSegmentIndex] ?? "";
  const sentences = splitSentencesPreservePunctuation(targetSegment);
  sentences[bestSentenceIndex] = bestReplacement;
  segments[bestSegmentIndex] = sentences.join("");
  return cleanupCompressedDescriptionContent(segments.join(""));
}

function dropLongestKeywordFreeSentenceOnce(input: string, minChars = 0): string {
  const paragraphs = input
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  let bestParagraphIndex = -1;
  let bestSentenceIndex = -1;
  let bestNextParagraph = "";
  let bestSaving = 0;

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex] ?? "";
    const sentences = splitSentencesPreservePunctuation(paragraph).map((sentence) => sentence.trim()).filter(Boolean);
    if (sentences.length <= 1) {
      continue;
    }
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex] ?? "";
      if (!sentence || sentence.includes("**")) {
        continue;
      }
      const nextSentences = sentences.filter((_value, index) => index !== sentenceIndex);
      if (nextSentences.length === 0) {
        continue;
      }
      const nextParagraph = cleanupCompressedDescriptionContent(nextSentences.join(" "));
      if (!nextParagraph) {
        continue;
      }
      const nextParagraphs = [...paragraphs];
      nextParagraphs[paragraphIndex] = nextParagraph;
      const nextContent = cleanupCompressedDescriptionContent(nextParagraphs.join("\n\n"));
      if (minChars > 0 && countLengthForValidation(nextContent) < minChars) {
        continue;
      }
      const saving = countLengthForValidation(input) - countLengthForValidation(nextContent);
      if (saving <= bestSaving) {
        continue;
      }
      bestParagraphIndex = paragraphIndex;
      bestSentenceIndex = sentenceIndex;
      bestNextParagraph = nextParagraph;
      bestSaving = saving;
    }
  }

  if (bestParagraphIndex < 0 || bestSentenceIndex < 0 || !bestNextParagraph) {
    return input;
  }

  const nextParagraphs = [...paragraphs];
  nextParagraphs[bestParagraphIndex] = bestNextParagraph;
  return cleanupCompressedDescriptionContent(nextParagraphs.join("\n\n"));
}

function trimDescriptionSentenceTailCandidate(
  sentence: string
): { sentence: string; saving: number } | null {
  const trimmed = sentence.trim();
  if (!trimmed) {
    return null;
  }
  const punctuation = /[.!?]$/.test(trimmed) ? trimmed.slice(-1) : "";
  const core = punctuation ? trimmed.slice(0, -1).trim() : trimmed;
  const candidates = [
    core.replace(/\s+that\s+[^.!?]+$/i, ""),
    core.replace(/\s+without\s+[^.!?]+$/i, ""),
    core.replace(/\s+across\s+[^.!?]+$/i, ""),
    core.replace(/\s+from\s+[^.!?]+$/i, ""),
    core.replace(/\s+during\s+[^.!?]+$/i, ""),
    core.includes("**") ? core : core.replace(/\s+and\s+[^.!?]{16,}$/i, "")
  ]
    .map((item) => normalizeLine(item))
    .filter((item) => item.length > 40 && item !== normalizeLine(core));
  if (candidates.length === 0) {
    return null;
  }
  const nextCore = candidates.sort((left, right) => left.length - right.length)[0] ?? "";
  const nextSentence = cleanupCompressedDescriptionContent(`${nextCore}${punctuation}`);
  const originalLength = countLengthForValidation(sentence);
  const nextLength = countLengthForValidation(nextSentence);
  if (nextLength >= originalLength) {
    return null;
  }
  return {
    sentence: nextSentence,
    saving: originalLength - nextLength
  };
}

function trimDescriptionSentenceTailOnce(input: string, minChars = 0): string {
  const paragraphs = input
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  let bestParagraphIndex = -1;
  let bestSentenceIndex = -1;
  let bestNextParagraph = "";
  let bestSaving = 0;

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex] ?? "";
    const sentences = splitSentencesPreservePunctuation(paragraph).map((sentence) => sentence.trim()).filter(Boolean);
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const candidate = trimDescriptionSentenceTailCandidate(sentences[sentenceIndex] ?? "");
      if (!candidate || candidate.saving <= bestSaving) {
        continue;
      }
      const nextSentences = [...sentences];
      nextSentences[sentenceIndex] = candidate.sentence;
      const nextParagraph = cleanupCompressedDescriptionContent(nextSentences.join(" "));
      if (!nextParagraph) {
        continue;
      }
      const nextParagraphs = [...paragraphs];
      nextParagraphs[paragraphIndex] = nextParagraph;
      const nextContent = cleanupCompressedDescriptionContent(nextParagraphs.join("\n\n"));
      if (minChars > 0 && countLengthForValidation(nextContent) < minChars) {
        continue;
      }
      bestParagraphIndex = paragraphIndex;
      bestSentenceIndex = sentenceIndex;
      bestNextParagraph = nextParagraph;
      bestSaving = candidate.saving;
    }
  }

  if (bestParagraphIndex < 0 || bestSentenceIndex < 0 || !bestNextParagraph) {
    return input;
  }

  const nextParagraphs = [...paragraphs];
  nextParagraphs[bestParagraphIndex] = bestNextParagraph;
  return cleanupCompressedDescriptionContent(nextParagraphs.join("\n\n"));
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
        `${heading}: Includes ${quantity || "12"} ${keywords[0]}${size ? ` in ${size.replace(/\s+/g, "")}` : ""} for daily use and restocking. ${keywords[1]} keeps the set easy to compare, and ${keywords[2]} adds practical value for home setups, guest spaces, backup storage, gift prep, and replacements without guesswork.`
      );
    case 1:
      return normalizeLine(
        `${heading}: ${keywords[0]} keeps setup simple and daily handling easier when details need to stay clear and usable. ${keywords[1]} supports quick decisions, and ${keywords[2]} adds flexible value for shared spaces, cabinets, travel prep, backup sets, and neat routine organization with less effort.`
      );
    case 2:
      return normalizeLine(
        `${heading}: ${keywords[0]} stays ready for repeat use, orderly storage, and steady replacement planning between busy routines. ${keywords[1]} helps maintain a clean setup, and ${keywords[2]} adds dependable value for home refreshes, guest areas, spare supplies, and everyday organization without extra clutter or wasted space.`
      );
    case 3:
      return normalizeLine(
        `${heading}: ${keywords[0]} adds a clear finished look without making the setup feel crowded or hard to manage. ${keywords[1]} keeps details easy to notice, and ${keywords[2]} fits gifting plans, shared rooms, display shelves, backup storage, and practical day-to-day arrangements with a tidy result.`
      );
    case 4:
      return normalizeLine(
        `${heading}: ${keywords[0]} works across everyday routines, guest prep, seasonal refreshes, and well-organized backup plans with flexible use. ${keywords[1]} adds visible value, and ${keywords[2]} helps the set stay easy to place, easy to rotate, and useful in homes, apartments, travel kits, and shared spaces.`
      );
    default:
      return normalizeLine(
        `${heading}: ${keywords[0]} keeps the setup practical and easy to place in everyday spaces. ${keywords[1]} adds clear value, and ${keywords[2]} supports tidy storage, repeat use, and steady organization without unnecessary clutter.`
      );
  }
}

function compressBulletLineToLimit(line: string, maxChars: number, lineIndex = 0, fallbackMaxChars = maxChars): string {
  if (maxChars <= 0 || countLengthForValidation(line) <= maxChars) {
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
    if (countLengthForValidation(current) <= maxChars) {
      return current;
    }
  }
  const fallback = buildFallbackBulletLine(current, lineIndex);
  if (fallback && countLengthForValidation(fallback) <= fallbackMaxChars) {
    return fallback;
  }
  return current;
}

function compressTitleToLimit(title: string, maxChars: number): string {
  if (maxChars <= 0 || countLengthForValidation(title) <= maxChars) {
    return title;
  }
  let current = title;
  for (const [pattern, replacement] of titleCompressionRules) {
    const next = normalizeLine(current.replace(pattern, replacement));
    if (next === current) {
      continue;
    }
    current = next;
    if (countLengthForValidation(current) <= maxChars) {
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
      if (countLengthForValidation(line) <= preferredMax) {
        return line;
      }
      return compressBulletLineToLimit(line, preferredMax, index, hardMax);
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

function compressDescriptionToLimit(content: string, minChars: number, maxChars: number): string {
  let current = cleanupCompressedDescriptionContent(content);
  if (maxChars <= 0 || countLengthForValidation(current) <= maxChars) {
    return current;
  }

  const applyRules = (): boolean => {
    let changed = false;
    for (const [pattern, replacement] of descriptionCompressionRules) {
      const next = cleanupCompressedDescriptionContent(
        transformNonKeywordSegments(current, (segment) => segment.replace(pattern, replacement))
      );
      if (next === current) {
        continue;
      }
      if (minChars > 0 && countLengthForValidation(next) < minChars) {
        continue;
      }
      current = next;
      changed = true;
      if (countLengthForValidation(current) <= maxChars) {
        return true;
      }
    }
    return changed;
  };

  applyRules();
  while (countLengthForValidation(current) > maxChars) {
    const pruned = pruneDescriptionCommaClauseOnce(current, minChars);
    if (pruned !== current) {
      current = pruned;
      if (countLengthForValidation(current) <= maxChars) {
        return current;
      }
      continue;
    }
    const tailTrimmed = trimDescriptionSentenceTailOnce(current, minChars);
    if (tailTrimmed !== current) {
      current = tailTrimmed;
      if (countLengthForValidation(current) <= maxChars) {
        return current;
      }
      continue;
    }
    const sentenceDropped = dropLongestKeywordFreeSentenceOnce(current, minChars);
    if (sentenceDropped !== current) {
      current = sentenceDropped;
      if (countLengthForValidation(current) <= maxChars) {
        return current;
      }
      continue;
    }
    const changed = applyRules();
    if (!changed) {
      break;
    }
    if (countLengthForValidation(current) <= maxChars) {
      return current;
    }
  }
  return current;
}

function extractDescriptionQuantityHint(raw: string, content: string): string {
  const text = `${raw}\n${content}`;
  const matched = /(?:数量\/包装|包装内含|set of|includes?)[:：]?\s*(\d{1,3})/i.exec(text);
  return matched?.[1]?.trim() || "12";
}

function extractDescriptionSizeHint(raw: string, content: string): string {
  const text = `${raw}\n${content}`;
  const matched = /(\d+\s*(?:x|\*)\s*\d+\s*(?:in|inch|inches)?|\d+\s*(?:in|inch|inches))/i.exec(text);
  if (!matched?.[1]) {
    return "";
  }
  return normalizeLine(matched[1].replace(/\*/g, "x"));
}

function extractDescriptionStyleHint(raw: string, content: string): string {
  const text = `${raw}\n${content}`.toLowerCase();
  if (text.includes("plaid")) {
    return "plaid";
  }
  if (text.includes("floral")) {
    return "floral";
  }
  if (text.includes("rainbow")) {
    return "rainbow";
  }
  if (text.includes("macaron")) {
    return "macaron";
  }
  if (text.includes("colorful")) {
    return "colorful";
  }
  return "bright";
}

function buildDescriptionFallbackVariant(
  keywords: string[][],
  quantity: string,
  size: string,
  style: string,
  mode: "expanded" | "standard" | "compact"
): string | null {
  const first = keywords[0] ?? [];
  const second = keywords[1] ?? [];
  const wrapped = (value: string): string => `**${value}**`;
  const sizeText = size ? ` in ${size} size` : "";
  const styleText = style ? style : "versatile";
  if (first.length >= 8 && second.length >= 7) {
    const firstSentence = (() => {
      switch (mode) {
        case "expanded":
          return `Set of ${quantity} ${wrapped(first[0])}${sizeText} brings ${styleText} style and practical value to daily use, gift prep, organized storage, and routine refreshes without overcomplicating the setup.`;
        case "compact":
          return `Set of ${quantity} ${wrapped(first[0])}${sizeText} brings ${styleText} style and practical value to everyday use, storage, and backup planning.`;
        default:
          return `Set of ${quantity} ${wrapped(first[0])}${sizeText} brings ${styleText} style and practical value to daily use, organized storage, routine refreshes, and steady replacement planning.`;
      }
    })();
    const firstTail = (() => {
      switch (mode) {
        case "expanded":
          return `These ${wrapped(first[1])} and ${wrapped(first[2])} details support ${wrapped(first[3])} and ${wrapped(first[4])}, while ${wrapped(first[5])}, ${wrapped(first[6])}, and ${wrapped(first[7])} keep the product easy to compare, easy to place, and ready for repeat use across different spaces and everyday routines.`;
        case "compact":
          return `${wrapped(first[1])}, ${wrapped(first[2])}, ${wrapped(first[3])}, ${wrapped(first[4])}, ${wrapped(first[5])}, ${wrapped(first[6])}, and ${wrapped(first[7])} keep the listing clear, easy to compare, and ready for repeat use across different setups.`;
        default:
          return `These ${wrapped(first[1])} and ${wrapped(first[2])} details support ${wrapped(first[3])} and ${wrapped(first[4])}, while ${wrapped(first[5])}, ${wrapped(first[6])}, and ${wrapped(first[7])} keep the product easy to compare and ready for repeat use.`;
      }
    })();
    const secondSentence = (() => {
      switch (mode) {
        case "expanded":
          return `It also works with ${wrapped(second[0])}, ${wrapped(second[1])}, and ${wrapped(second[2])} when shoppers want more ways to match size, finish, function, or presentation.`;
        case "compact":
          return `${wrapped(second[0])}, ${wrapped(second[1])}, and ${wrapped(second[2])} extend the range for shoppers comparing finish, fit, function, or presentation in one listing.`;
        default:
          return `It also works with ${wrapped(second[0])}, ${wrapped(second[1])}, and ${wrapped(second[2])} when shoppers want more ways to match size, finish, or function in one listing.`;
      }
    })();
    const secondTail = (() => {
      switch (mode) {
        case "expanded":
          return `${wrapped(second[3])}, ${wrapped(second[4])}, and ${wrapped(second[5])} broaden the use coverage, while ${wrapped(second[6])} helps the listing stay specific, flexible, and useful for home routines, backup sets, gifting plans, and well-organized spaces.`;
        case "compact":
          return `${wrapped(second[3])}, ${wrapped(second[4])}, and ${wrapped(second[5])} broaden coverage, while ${wrapped(second[6])} keeps the set specific for daily routines, backup storage, gifting plans, and organized spaces without extra clutter.`;
        default:
          return `${wrapped(second[3])}, ${wrapped(second[4])}, and ${wrapped(second[5])} broaden the use coverage, while ${wrapped(second[6])} keeps the listing specific and useful for backup sets, gifting plans, organized spaces, and daily routines.`;
      }
    })();
    return `${firstSentence} ${firstTail}\n\n${secondSentence} ${secondTail}`;
  }
  if (first.length < 3 || second.length < 3) {
    return null;
  }
  const firstSentence = (() => {
    switch (mode) {
      case "expanded":
        return `Set of ${quantity} ${wrapped(first[0])}${sizeText} brings ${styleText} style and practical value to daily displays, organized storage, backup planning, and repeat use without making setup feel cluttered or complicated.`;
      case "compact":
        return `Set of ${quantity} ${wrapped(first[0])}${sizeText} brings ${styleText} style and practical value to daily displays, storage, and repeat use.`;
      default:
        return `Set of ${quantity} ${wrapped(first[0])}${sizeText} brings ${styleText} style and practical value to daily displays, organized storage, refreshes, and replacement planning.`;
    }
  })();
  const firstTail = (() => {
    switch (mode) {
      case "expanded":
        return `These ${wrapped(first[1])} and ${wrapped(first[2])} details keep the listing specific, easy to compare, and useful for shoppers who want ready-to-use decor with clear coverage across classrooms, home corners, event tables, teacher displays, and seasonal refreshes.`;
      case "compact":
        return `${wrapped(first[1])} and ${wrapped(first[2])} keep the listing clear, practical, and easy to compare for repeat use, backup sets, and neat storage.`;
      default:
        return `These ${wrapped(first[1])} and ${wrapped(first[2])} details keep the listing specific, easy to compare, and ready for repeat use across common setups, teacher projects, and planned seasonal resets.`;
    }
  })();
  const secondSentence = (() => {
    switch (mode) {
      case "expanded":
        return `It also works with ${wrapped(second[0])}, ${wrapped(second[1])}, and ${wrapped(second[2])} when buyers need flexible options for ceilings, welcome walls, reading corners, party tables, or quick room updates that still look coordinated and intentional.`;
      case "compact":
        return `${wrapped(second[0])}, ${wrapped(second[1])}, and ${wrapped(second[2])} extend the range for shoppers comparing finish, fit, and function in one listing.`;
      default:
        return `It also works with ${wrapped(second[0])}, ${wrapped(second[1])}, and ${wrapped(second[2])} when shoppers want flexible ways to match finish, function, and presentation in one listing.`;
    }
  })();
  const secondTail = (() => {
    switch (mode) {
      case "expanded":
        return `The fold-flat structure supports fast setup, tidy storage, repeat placement, gifting plans, dependable backup coverage, and organized event prep, so the description stays useful and natural instead of padded with empty claims.`;
      case "compact":
        return `The fold-flat structure supports fast setup, tidy storage, repeat placement, and organized resets without extra clutter.`;
      default:
        return `The fold-flat structure supports fast setup, tidy storage, repeat placement, dependable backup planning, and organized event prep, so the description stays specific and useful for daily routines.`;
    }
  })();
  return `${firstSentence} ${firstTail}\n\n${secondSentence} ${secondTail}`;
}

function buildDescriptionFallbackContent(
  requirements: ListingRequirements,
  rule: SectionRule,
  content: string,
  minChars: number,
  maxChars: number
): string | null {
  const keywordPlan = buildSectionKeywordPlan(requirements, rule);
  if (keywordPlan.length < 2) {
    return null;
  }
  const quantity = extractDescriptionQuantityHint(requirements.raw, content);
  const size = extractDescriptionSizeHint(requirements.raw, content);
  const style = extractDescriptionStyleHint(requirements.raw, content);
  const variants = [
    buildDescriptionFallbackVariant(keywordPlan, quantity, size, style, "expanded"),
    buildDescriptionFallbackVariant(keywordPlan, quantity, size, style, "standard"),
    buildDescriptionFallbackVariant(keywordPlan, quantity, size, style, "compact")
  ].filter((value): value is string => Boolean(value));
  const normalizedVariants = variants
    .map((variant) => cleanupCompressedDescriptionContent(variant))
    .map((variant) => ({
      content: variant,
      visibleLength: countLengthForValidation(variant)
    }));
  const inRange = normalizedVariants.find((item) => rangeCheck(item.visibleLength, minChars, maxChars));
  if (inRange) {
    return inRange.content;
  }
  const underMax = normalizedVariants
    .filter((item) => item.visibleLength <= maxChars)
    .sort((left, right) => right.visibleLength - left.visibleLength)[0];
  if (underMax) {
    return underMax.content;
  }
  const shortest = normalizedVariants.sort((left, right) => left.visibleLength - right.visibleLength)[0];
  return shortest?.content ?? null;
}

function normalizeDescriptionContentForValidation(
  content: string,
  rule: SectionRule,
  requirements?: ListingRequirements
): string {
  if (rule.section !== "description") {
    return content;
  }
  const minChars = getNumber(rule.constraints, "min_chars", 0);
  const rawMaxChars = getNumber(rule.constraints, "max_chars", 0);
  if (rawMaxChars <= 0) {
    return cleanupCompressedDescriptionContent(content);
  }
  const hardMax = rawMaxChars + getTolerance(rule.constraints);
  const maxChars = hardMax > 0 ? hardMax : rawMaxChars;
  const compressed = compressDescriptionToLimit(content, minChars, maxChars);
  if (requirements) {
    const compressedErrors = validateSectionContent(compressed, requirements, rule);
    const needsFallback =
      (maxChars > 0 && countLengthForValidation(compressed) > maxChars) ||
      compressedErrors.some((error) => error.startsWith("段落数量不满足约束:"));
    if (needsFallback) {
      const fallback = buildDescriptionFallbackContent(requirements, rule, compressed, minChars, maxChars);
      if (fallback) {
        return fallback;
      }
    }
  }
  return compressed;
}

function normalizeSectionContentForValidation(
  content: string,
  rule: SectionRule,
  requirements?: ListingRequirements
): string {
  if (rule.section === "bullets") {
    return normalizeBulletsContentForValidation(content, rule);
  }
  if (rule.section === "title") {
    return normalizeTitleContentForValidation(content, rule);
  }
  if (rule.section === "description") {
    return normalizeDescriptionContentForValidation(content, rule, requirements);
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

function normalizeSectionCandidateForScoring(
  raw: string,
  rule: SectionRule,
  requirements?: ListingRequirements
): { content: string; error?: string } {
  if (rule.section === "bullets") {
    const trimmed = normalizeText(raw);
    if (trimmed.startsWith("{")) {
      const adapted = adaptJSONArrayContent(raw, rule.output.json_array_field || "bullets");
      return {
        ...adapted,
        content: normalizeSectionContentForValidation(adapted.content, rule, requirements)
      };
    }
    return { content: normalizeSectionContentForValidation(trimmed, rule, requirements) };
  }
  const adapted = adaptMarkdownContentForValidation(raw, rule);
  return {
    ...adapted,
    content: normalizeSectionContentForValidation(adapted.content, rule, requirements)
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
            normalized_chars: countLengthForValidation(candidate.normalizedContent),
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
  const adapted = normalizeSectionCandidateForScoring(raw, rule, requirements);
  const normalized = normalizeText(normalizeSectionContentForValidation(adapted.content, rule, requirements));
  const normalizedLength = countLengthForValidation(normalized);
  const errors = adapted.error ? [adapted.error] : validateSectionContent(normalized, requirements, rule);
  const targetMidpoint = (() => {
    const minChars = getNumber(rule.constraints, "min_chars", 0);
    const maxChars = getNumber(rule.constraints, "max_chars", 0);
    if (minChars > 0 && maxChars > 0) {
      return Math.floor((minChars + maxChars) / 2);
    }
    const minPerLine = getNumber(rule.constraints, "min_chars_per_line", 0);
    const maxPerLine = getNumber(rule.constraints, "max_chars_per_line", 0);
    const preferredMinPerLine = getNumber(rule.constraints, "preferred_min_chars_per_line", 0);
    const preferredMaxPerLine = getNumber(rule.constraints, "preferred_max_chars_per_line", 0);
    const lineCount = getNumber(rule.constraints, "line_count", 0);
    if (preferredMinPerLine > 0 && preferredMaxPerLine > 0 && lineCount > 0) {
      return Math.floor(((preferredMinPerLine + preferredMaxPerLine) / 2) * lineCount);
    }
    if (minPerLine > 0 && maxPerLine > 0 && lineCount > 0) {
      return Math.floor(((minPerLine + maxPerLine) / 2) * lineCount);
    }
    return normalizedLength;
  })();
  const proximityPenalty = Math.abs(normalizedLength - targetMidpoint);
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

function resolveBulletRepairTargetRange(rule: SectionRule): { min: number; max: number } {
  if (rule.section !== "bullets") {
    const preferredMin = getNumber(rule.constraints, "preferred_min_chars_per_line", 0);
    const preferredMax = getNumber(rule.constraints, "preferred_max_chars_per_line", 0);
    return { min: preferredMin, max: preferredMax >= preferredMin ? preferredMax : preferredMin };
  }
  const rawMax = getNumber(rule.constraints, "max_chars_per_line", 0);
  const tolerance = getTolerance(rule.constraints);
  if (rawMax > 0) {
    const min = rawMax + 2;
    const hardMax = rawMax + tolerance;
    const max = hardMax > 0 ? Math.min(rawMax + 8, hardMax) : rawMax + 8;
    return { min, max: Math.max(min, max) };
  }
  const preferredMin = getNumber(rule.constraints, "preferred_min_chars_per_line", 0);
  const preferredMax = getNumber(rule.constraints, "preferred_max_chars_per_line", 0);
  return { min: preferredMin, max: preferredMax >= preferredMin ? preferredMax : preferredMin };
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
  const normalizedLength = countLengthForValidation(normalized);
  const errors: string[] = [];
  const requireCompleteSentenceEnd = constraints.require_complete_sentence_end === true;
  const forbidDanglingTail = constraints.forbid_dangling_tail === true;
  const rawMinChars = getNumber(constraints, "min_chars", 0);
  const rawMaxChars = getNumber(constraints, "max_chars", 0);
  const hardMinForBullets = rule.section === "bullets";
  const minChars = rawMinChars > 0 ? (hardMinForBullets ? rawMinChars : rawMinChars - tolerance) : 0;
  const maxChars = rawMaxChars > 0 ? rawMaxChars + tolerance : 0;
  const hasTextLengthConstraint = rawMinChars > 0 || rawMaxChars > 0;
  if (hasTextLengthConstraint && !rangeCheck(normalizedLength, Math.max(0, minChars), maxChars)) {
    errors.push(
      `长度不满足约束: ${normalizedLength}（规则区间 ${formatRange(rawMinChars, rawMaxChars)}，容差区间 ${formatRange(Math.max(0, minChars), maxChars)}）`
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
      const lineLength = countLengthForValidation(line);
      const ok = rangeCheck(lineLength, Math.max(0, minCharsPerLine), maxCharsPerLine);
      if (!ok) {
        errors.push(
          `第${i + 1}条长度不满足约束: ${lineLength}（规则区间 ${formatRange(rawMinCharsPerLine, rawMaxCharsPerLine)}，容差区间 ${formatRange(Math.max(0, minCharsPerLine), maxCharsPerLine)}）`
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
        for (let i = 0; i < target; i += 1) {
          const kw = keywords[i];
          if (!findKeywordOccurrence(text, kw, 0, keywordEmbedding)) {
            errors.push(`缺少关键词 #${i + 1}: ${kw}`);
          }
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

function compactSearchTermsToMaxChars(values: string[], separator: string, maxChars: number): string[] {
  if (maxChars <= 0 || values.length === 0) {
    return values;
  }
  const selected: string[] = [];
  for (const value of values) {
    const candidate = selected.length === 0
      ? value
      : `${selected.join(separator)}${separator}${value}`;
    if (candidate.length <= maxChars) {
      selected.push(value);
    }
  }
  if (selected.length > 0) {
    return selected;
  }
  return [values[0] ?? ""].filter(Boolean);
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
  const maxChars = getNumber(rule.constraints, "max_chars", 0);
  values = compactSearchTermsToMaxChars(values, separator, maxChars);
  const content = normalizeText(normalizeSectionContentForValidation(values.join(separator), rule, requirements));
  const errors = validateSectionContent(content, requirements, rule);
  if (errors.length > 0) {
    throw new Error(`search_terms validation failed: ${errors.join("; ")}`);
  }
  return content;
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

function extractKeywordErrorIndex(error: string): number | null {
  const matched = /^关键词顺序埋入不满足:\s*第(\d+)个关键词/.exec(error.trim());
  if (!matched) {
    return null;
  }
  const index = Number.parseInt(matched[1], 10);
  return Number.isFinite(index) && index > 0 ? index - 1 : null;
}

function keywordIndexToLineIndex(keywordIndex: number, slotKeywordCounts: number[]): number | null {
  if (keywordIndex < 0) {
    return null;
  }
  let cursor = 0;
  for (let lineIndex = 0; lineIndex < slotKeywordCounts.length; lineIndex += 1) {
    const next = cursor + slotKeywordCounts[lineIndex];
    if (keywordIndex < next) {
      return lineIndex;
    }
    cursor = next;
  }
  return null;
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

function stripSingleLineRepairLabel(line: string): string {
  const normalized = normalizeLine(line);
  if (!normalized) {
    return "";
  }
  const matched = /^(?:(?:修复后(?:的)?|最终|输出|结果)(?:\s*bullet)?|(?:revised|fixed|updated|final)\s+bullet|final\s+output|output|result|answer)\s*[:：-]\s*(.+)$/i.exec(normalized);
  if (!matched) {
    return normalized;
  }
  return normalizeLine(matched[1] ?? "");
}

function collectSingleLineRepairVariants(raw: string, rule: SectionRule, targetIndex: number): string[] {
  const trimmed = normalizeText(raw);
  if (!trimmed) {
    return [];
  }
  const variants: string[] = [];
  const seen = new Set<string>();
  const pushVariant = (value: string): void => {
    const normalized = stripSingleLineRepairLabel(stripBulletPrefix(value)).replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!normalized || normalized === "```") {
      return;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      variants.push(normalized);
    }
  };
  if (rule.output.format === "json") {
    const field = rule.output.json_array_field || "bullets";
    const adapted = adaptJSONArrayContent(trimmed, field);
    if (!adapted.error) {
      const lines = splitLines(adapted.content);
      if (targetIndex >= 0 && targetIndex < lines.length) {
        pushVariant(lines[targetIndex] ?? "");
      }
      for (const line of lines) {
        pushVariant(line);
      }
    }
  }
  for (const line of trimmed.replace(/\r\n/g, "\n").split("\n")) {
    pushVariant(line);
  }
  return variants;
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
  if (section === "description") {
    return 8;
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

function buildRelevantErrorsForBulletLine(
  requirements: ListingRequirements,
  rule: SectionRule,
  targetLineIndex: number
): (allErrors: string[]) => string[] {
  const keywordPlan = buildSectionKeywordPlan(requirements, rule).map((keywords: string[]) => keywords.length);
  return (allErrors: string[]) => allErrors.filter((error) => {
    const lineIndex = extractLineErrorIndex(error);
    if (lineIndex === targetLineIndex) {
      return true;
    }
    const keywordIndex = extractKeywordErrorIndex(error);
    if (keywordIndex === null) {
      return false;
    }
    const mapped = keywordIndexToLineIndex(keywordIndex, keywordPlan);
    return mapped === targetLineIndex;
  });
}

function scoreRelevantSectionErrors(relevant: string[]): number {
  if (relevant.length === 0) {
    return 0;
  }
  let penalty = relevant.length * 10_000;
  for (const error of relevant) {
    const normalized = normalizeLine(error);
    const lineMatched = lineLengthErrorPattern.exec(normalized);
    if (lineMatched) {
      const actual = Number.parseInt(lineMatched[2] ?? "0", 10);
      const tolMin = Number.parseInt(lineMatched[5] ?? "0", 10);
      const tolMax = Number.parseInt(lineMatched[6] ?? "0", 10);
      penalty += actual < tolMin ? tolMin - actual : Math.max(0, actual - tolMax);
      continue;
    }
    if (normalized.includes("关键词顺序埋入不满足")) {
      penalty += 5_000;
      continue;
    }
    penalty += 1_000;
  }
  return penalty;
}

type SingleLineRepairChoice = {
  line: string;
  normalizedContent: string;
  lines: string[];
  relevantErrors: string[];
  allErrors: string[];
  score: number;
  visibleLength: number;
  changed: boolean;
};

function pickSingleLineRepairCandidate(
  requirements: ListingRequirements,
  rule: SectionRule,
  lines: string[],
  targetIndex: number,
  raw: string
): SingleLineRepairChoice {
  const currentLine = lines[targetIndex] ?? "";
  const variants = collectSingleLineRepairVariants(raw, rule, targetIndex);
  if (!variants.includes(currentLine)) {
    variants.push(currentLine);
  }
  const relevantErrorsForLine = buildRelevantErrorsForBulletLine(requirements, rule, targetIndex);
  const repairTarget = resolveBulletRepairTargetRange(rule);
  const targetMid = repairTarget.min > 0 && repairTarget.max >= repairTarget.min
    ? Math.floor((repairTarget.min + repairTarget.max) / 2)
    : countLengthForValidation(currentLine);
  const evaluated = variants.map((candidateLine) => {
    const candidateLines = [...lines];
    candidateLines[targetIndex] = candidateLine;
    const normalizedCandidateContent = normalizeText(normalizeSectionContentForValidation(candidateLines.join("\n"), rule));
    const candidateLinesNormalized = splitLines(normalizedCandidateContent);
    const candidateErrors = validateSectionContent(normalizedCandidateContent, requirements, rule);
    const relevantCandidateErrors = relevantErrorsForLine(candidateErrors);
    const finalLine = candidateLinesNormalized[targetIndex] ?? candidateLine;
    return {
      line: finalLine,
      normalizedContent: normalizedCandidateContent,
      lines: candidateLinesNormalized,
      relevantErrors: relevantCandidateErrors,
      allErrors: candidateErrors,
      score: scoreRelevantSectionErrors(relevantCandidateErrors),
      visibleLength: countLengthForValidation(finalLine),
      changed: normalizeLine(finalLine) !== normalizeLine(currentLine)
    };
  });
  evaluated.sort((left, right) =>
    left.score - right.score
    || Math.abs(left.visibleLength - targetMid) - Math.abs(right.visibleLength - targetMid)
    || Number(right.changed) - Number(left.changed)
    || right.visibleLength - left.visibleLength
  );
  return evaluated[0] ?? {
    line: currentLine,
    normalizedContent: lines.join("\n"),
    lines: [...lines],
    relevantErrors: [],
    allErrors: [],
    score: 0,
    visibleLength: countLengthForValidation(currentLine),
    changed: false
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

export function buildFallbackBulletLineForTest(line: string, lineIndex: number): string {
  return buildFallbackBulletLine(line, lineIndex) ?? "";
}

export function pickSingleLineRepairCandidateForTest(
  requirements: ListingRequirements,
  rule: SectionRule,
  lines: string[],
  targetIndex: number,
  raw: string
): { line: string; relevantErrors: string[] } {
  const selected = pickSingleLineRepairCandidate(requirements, rule, lines, targetIndex, raw);
  return {
    line: selected.line,
    relevantErrors: selected.relevantErrors
  };
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
  private readonly versionService: VersionService;
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
    this.versionService = new VersionService();
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
    const keywordEmbedding = readKeywordEmbeddingConfig(constraints);
    const lines: string[] = [];
    const lineCount = getNumber(constraints, "line_count", 0);
    const rawMinPerLine = getNumber(constraints, "min_chars_per_line", 0);
    const rawMaxPerLine = getNumber(constraints, "max_chars_per_line", 0);
    const preferredMinPerLine = getNumber(constraints, "preferred_min_chars_per_line", 0);
    const preferredMaxPerLine = getNumber(constraints, "preferred_max_chars_per_line", 0);
    const rawMinChars = getNumber(constraints, "min_chars", 0);
    const rawMaxChars = getNumber(constraints, "max_chars", 0);
    const minParagraphs = getNumber(constraints, "min_paragraphs", 0);
    const maxParagraphs = getNumber(constraints, "max_paragraphs", 0);

    if (lineCount > 0) {
      lines.push(`- 行数必须=${lineCount}`);
    }
    if (rawMinPerLine > 0 || rawMaxPerLine > 0) {
      const hardMinPerLine = rule.section === "bullets";
      const tolMin = rawMinPerLine > 0 ? (hardMinPerLine ? rawMinPerLine : Math.max(0, rawMinPerLine - tolerance)) : 0;
      const tolMax = rawMaxPerLine > 0 ? rawMaxPerLine + tolerance : 0;
      lines.push(`- 每行长度：规则${formatRange(rawMinPerLine, rawMaxPerLine)}，容差${formatRange(tolMin, tolMax)}`);
    }
    if (preferredMinPerLine > 0 || preferredMaxPerLine > 0) {
      lines.push(`- 每条最佳落点 ${preferredMinPerLine}-${preferredMaxPerLine} 字符，略高于 250 字符更稳妥`);
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
    if (keywordEmbedding.boldWrapper) {
      lines.push("- 长度统计时，连续的 2 个星号 ** 不计入字符数");
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
    const sectionSpecificRepairRules = (() => {
      if (rule.section !== "bullets") {
        return "";
      }
      const minCharsPerLine = getNumber(rule.constraints, "min_chars_per_line", 0);
      const repairTarget = resolveBulletRepairTargetRange(rule);
      return [
        minCharsPerLine > 0 ? `低于 ${minCharsPerLine} 字符的条目直接视为失败。` : "",
        repairTarget.min > 0 && repairTarget.max > 0 ? `偏短条目优先补到 ${repairTarget.min}-${repairTarget.max} 可见字符。` : "",
        repairTarget.min > 0 ? `不要停在 230-239 这类仍会失败的长度，至少补到 ${repairTarget.min} 字符以上再停。` : "",
        "未报错的条目尽量逐字保持原样，不要顺手改写已经通过的条目。",
        "当条目偏短时，优先补 1 个具体产品细节、使用结果或安装收益，不要只换同义词。"
      ].filter(Boolean).join("\n");
    })();
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
      sectionSpecificRepairRules,
      `section=${rule.section}`,
      `规则:\n${rule.instruction}`,
      `硬性约束摘要:\n${constraintsSummary}`,
      `硬性约束(JSON):\n${constraintsJSON}`
    ].join("\n");
  }

  private buildBulletItemRepairSystemPrompt(rule: SectionRule, targetIndex: number, relevantErrors: string[]): string {
    const repairTarget = resolveBulletRepairTargetRange(rule);
    const targetText = repairTarget.min > 0 && repairTarget.max > 0
      ? `把最终长度控制在 ${repairTarget.min}-${repairTarget.max} 个可见字符。`
      : "把最终长度控制在规则允许范围内。";
    const hasKeywordOrderError = relevantErrors.some((error) => extractKeywordErrorIndex(error) !== null);
    const lineViolation = relevantErrors
      .map((error) => lineLengthErrorPattern.exec(normalizeLine(error)))
      .find((matched) => matched && Number.parseInt(matched[1] ?? "", 10) === targetIndex + 1);
    const deltaText = (() => {
      if (!lineViolation) {
        return "";
      }
      const actual = Number.parseInt(lineViolation[2] ?? "0", 10);
      const tolMin = Number.parseInt(lineViolation[5] ?? "0", 10);
      const tolMax = Number.parseInt(lineViolation[6] ?? "0", 10);
      if (actual > 0 && tolMin > 0 && actual < tolMin) {
        const shortBy = tolMin - actual;
        const addMin = shortBy <= 8 ? 12 : Math.max(shortBy + 6, 12);
        const addMax = shortBy <= 8 ? 20 : Math.max(shortBy + 16, addMin + 4);
        return `当前只差 ${shortBy} 个可见字符，即使差距很小也要至少净增 ${addMin}-${addMax} 个可见字符，不要只改小标题或替换同义词。`;
      }
      if (actual > tolMax && tolMax > 0) {
        return `当前超出上限 ${actual - tolMax} 个可见字符，这一轮要压缩而不是换个更长版本。`;
      }
      return "";
    })();
    return [
      "你是英文 bullet 定点修复专家。",
      "这一轮只允许修复 1 条 bullet，只输出修复后的这一条。",
      "本轮是补差修复，不是整条扩写。",
      "长度按可见字符计算：空格和标点计入，连续的 2 个星号 ** 不计入长度。",
      "尽量保留原句结构、已正确的关键词顺序和主要语义，只补必要差额。",
      targetText,
      "不要扩写到 280 个可见字符以上；一旦超过就视为修坏。",
      "不要新增第三个分句，不要并列多个场景串，不要堆空泛形容词。",
      hasKeywordOrderError ? "如果缺少或乱序的是本条关键词，先删掉旧的场景串或泛化短语，给缺失关键词腾位。" : "",
      hasKeywordOrderError ? "不要在句尾直接追加缺失关键词或额外整句；先压缩旧表达，再把缺失关键词放回原句位置。" : "",
      deltaText
    ].filter(Boolean).join("\n");
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

  private bulletRepairTargetIndexes(
    requirements: ListingRequirements,
    rule: SectionRule,
    errors: string[]
  ): number[] {
    const indexes = new Set<number>();
    for (const error of errors) {
      const lineIndex = extractLineErrorIndex(error);
      if (lineIndex !== null) {
        indexes.add(lineIndex);
      }
    }
    const keywordIndex = errors
      .map((error) => extractKeywordErrorIndex(error))
      .find((value): value is number => value !== null);
    if (keywordIndex !== undefined) {
      const keywordPlan = buildSectionKeywordPlan(requirements, rule);
      const lineIndex = keywordIndexToLineIndex(
        keywordIndex,
        keywordPlan.map((keywords: string[]) => keywords.length)
      );
      if (lineIndex !== null) {
        indexes.add(lineIndex);
      }
    }
    return [...indexes].sort((left, right) => left - right);
  }

  private async repairBulletItems(
    requirements: ListingRequirements,
    rule: SectionRule,
    content: string,
    initialErrors: string[]
  ): Promise<{ content: string; errors: string[] }> {
    let lines = splitLines(content);
    let errors = [...initialErrors];
    const targetIndexes = this.bulletRepairTargetIndexes(requirements, rule, errors);
    if (targetIndexes.length === 0 || lines.length === 0) {
      return { content, errors };
    }
    const maxLineRepairRounds = 3;
    for (const targetIndex of targetIndexes) {
      const relevantErrorsForLine = buildRelevantErrorsForBulletLine(requirements, rule, targetIndex);
      for (let round = 1; round <= maxLineRepairRounds; round += 1) {
        const normalizedCurrentContent = normalizeText(normalizeSectionContentForValidation(lines.join("\n"), rule));
        lines = splitLines(normalizedCurrentContent);
        const currentErrors = validateSectionContent(normalizedCurrentContent, requirements, rule);
        const relevantErrors = relevantErrorsForLine(currentErrors);
        if (relevantErrors.length === 0) {
          errors = currentErrors;
          break;
        }
        await this.appendTrace("bullet_item_repair_start", "warn", {
          line_index: targetIndex + 1,
          repair_round: round,
          errors: relevantErrors
        });
        const prompt = [
          `任务: 只修复第${targetIndex + 1}条英文 bullet，只输出这一条。`,
          "不要输出编号，不要输出 JSON，不要输出其他条目。",
          `当前第${targetIndex + 1}条:\n${lines[targetIndex] ?? ""}`,
          "完整五点上下文（仅供参考，其他条目不能改）:",
          lines.map((line, index) => `${index + 1}. ${line}`).join("\n"),
          "",
          buildSectionRepairGuidance(requirements, rule, relevantErrors)
        ].join("\n");
        const repairCandidates = await Promise.allSettled(
          [1, 2].map(async (candidateIndex) => {
            const raw = await this.llmClient.generateText(
              [
                this.buildBulletItemRepairSystemPrompt(rule, targetIndex, relevantErrors),
                candidateIndex === 1
                  ? "修复候选#1：优先最小改动，先保留原句结构和已存在信息。"
                  : "修复候选#2：允许更积极地补足或压缩长度，但不要改变语义主干。",
                "不要回显原文，不要输出 Original/Revised/Final/修复后 这类标签。",
                "未报错的其他条目不能改。",
                "只输出修复后的单条 bullet 文本，不要解释。"
              ].join("\n"),
              [`修复候选#${candidateIndex}`, prompt].join("\n\n"),
              `bullets_item_repair_line_${targetIndex + 1}_round_${round}_candidate_${candidateIndex}`,
              2,
              "repair"
            );
            const selected = pickSingleLineRepairCandidate(requirements, rule, lines, targetIndex, raw);
            return {
              candidateIndex,
              normalizedContent: selected.normalizedContent,
              lines: selected.lines,
              relevantErrors: selected.relevantErrors,
              allErrors: selected.allErrors,
              score: selected.score,
              visibleLength: selected.visibleLength
            };
          })
        );
        const evaluatedCandidates = repairCandidates
          .filter((result): result is PromiseFulfilledResult<{
            candidateIndex: number;
            normalizedContent: string;
            lines: string[];
            relevantErrors: string[];
            allErrors: string[];
            score: number;
            visibleLength: number;
          }> => result.status === "fulfilled")
          .map((result) => result.value)
          .sort((left, right) => left.score - right.score || left.candidateIndex - right.candidateIndex);
        if (evaluatedCandidates.length === 0) {
          continue;
        }
        const chosen = evaluatedCandidates[0];
        lines = chosen.lines;
        errors = chosen.allErrors;
        const stillRelevant = chosen.relevantErrors;
        await this.appendTrace(stillRelevant.length === 0 ? "bullet_item_repair_ok" : "bullet_item_repair_failed", stillRelevant.length === 0 ? "info" : "warn", {
          line_index: targetIndex + 1,
          repair_round: round,
          repair_candidate_count: evaluatedCandidates.length,
          repair_candidates: evaluatedCandidates.map((candidate) => ({
            candidate_index: candidate.candidateIndex,
            score: candidate.score,
            error_count: candidate.relevantErrors.length,
            visible_length: candidate.visibleLength,
            selected: candidate.candidateIndex === chosen.candidateIndex
          })),
          errors: stillRelevant,
          content: lines[targetIndex] ?? ""
        });
        if (stillRelevant.length === 0) {
          break;
        }
      }
    }
    return {
      content: lines.join("\n"),
      errors
    };
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
    await this.appendTrace("translation_start", "info", { step, retries, ...buildInputCharMetrics(text) });
    this.logger.info({ event: "translation_start", step, retries, ...buildInputCharMetrics(text) }, "translation start");
    const translated = await this.llmClient.translateWithTranslatorAgent(
      rules.generationConfig.translation.system_prompt,
      text,
      step,
      Math.max(1, retries),
      runtimeProfile
    );
    this.logger.info(
      { event: "translation_ok", step, duration_ms: Date.now() - started, ...buildOutputCharMetrics(translated) },
      "translation ok"
    );
    await this.appendTrace("translation_ok", "info", {
      step,
      duration_ms: Date.now() - started,
      ...buildOutputCharMetrics(translated)
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
        ...buildOutputCharMetrics(normalized)
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
            const normalized = normalizeText(normalizeSectionContentForValidation(adapted.content, rule, requirements));
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
          const normalized = normalizeText(normalizeSectionContentForValidation(adapted.content, rule, requirements));
          const errors = adapted.error ? [adapted.error] : validateSectionContent(normalized, requirements, rule);
          return {
            ok: errors.length === 0,
            normalizedContent: normalized,
            finalOutput: isBullets ? formatJSONArrayContent(normalized, bulletsJSONArrayField) : normalized,
            errors,
            repairGuidance: buildSectionRepairGuidance(requirements, rule, errors)
          };
        };
        try {
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
        } catch (error) {
          if (
            isBullets &&
            rule.execution.repair_mode === "item" &&
            error instanceof SectionAgentTeamValidationError &&
            error.normalizedContent.trim() !== ""
          ) {
            const repaired = await this.repairBulletItems(requirements, rule, error.normalizedContent, error.errors);
            if (repaired.errors.length === 0) {
              return repaired.content;
            }
            throw new Error(`section agent team validation failed: ${repaired.errors.join("; ")}`);
          }
          throw error;
        }
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
    const runtimeVersion = await this.versionService.read();
    this.currentRules = tenantRules;
    await this.appendTrace("rules_loaded", "info", {
      archive_path: archivePath,
      rules_version: input.rulesVersion,
      worker_version: runtimeVersion.worker_version
    });

    if (!inputMatchesMarker(input.inputMarkdown, tenantRules.input)) {
      const marker = tenantRules.input.file_discovery.marker;
      await this.appendTrace("generation_invalid_input", "error", {
        error: `输入文件未命中当前租户模板标记: ${marker}`,
        expected_marker: marker,
        input_filename: inputFilename || undefined
      });
      throw new InputValidationError(`输入文件未命中当前租户模板标记: ${marker}`);
    }

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
