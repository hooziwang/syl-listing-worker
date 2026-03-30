import type { ListingRequirements } from "./requirements-parser.js";
import type { SectionRule } from "./rules-loader.js";

type KeywordEmbeddingConfig = {
  enabled: boolean;
  minTotal: number;
  enforceOrder: boolean;
  lowercase: boolean;
};

type LengthViolation = {
  actual: number;
  tolMin: number;
  tolMax: number;
};

type SlotLengthBudget = {
  min: number;
  max: number;
  load?: "light" | "heavy";
};

const lineLengthErrorPattern = /^第(\d+)条长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;
const textLengthErrorPattern = /^长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;

function getNumber(constraints: Record<string, unknown>, key: string, fallback = 0): number {
  const value = constraints[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readKeywordEmbeddingConfig(constraints: Record<string, unknown>): KeywordEmbeddingConfig {
  const node = (constraints.keyword_embedding as Record<string, unknown> | undefined) ?? {};
  const minTotalRaw = typeof node.min_total === "number" && Number.isFinite(node.min_total) ? node.min_total : 0;
  return {
    enabled: node.enabled === true,
    minTotal: Math.max(0, Math.floor(minTotalRaw)),
    enforceOrder: node.enforce_order !== false,
    lowercase: node.lowercase === true
  };
}

function normalizeLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function formatGuidanceKeyword(keyword: string, lowercase: boolean): string {
  const normalized = normalizeLine(keyword);
  return lowercase ? normalized.toLowerCase() : normalized;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function extractLineErrorIndex(error: string): number | null {
  const matched = /^第(\d+)条/.exec(error.trim());
  if (!matched) {
    return null;
  }
  const index = Number.parseInt(matched[1], 10);
  return Number.isFinite(index) && index > 0 ? index - 1 : null;
}

function extractKeywordErrorIndex(error: string): number | null {
  const matched = /^关键词顺序埋入不满足:\s*第(\d+)个关键词/.exec(error.trim());
  if (!matched) {
    return null;
  }
  const index = Number.parseInt(matched[1], 10);
  return Number.isFinite(index) && index > 0 ? index - 1 : null;
}

function extractParagraphErrorIndex(error: string): number | null {
  const matched = /^第(\d+)段/.exec(error.trim());
  if (!matched) {
    return null;
  }
  const index = Number.parseInt(matched[1], 10);
  return Number.isFinite(index) && index > 0 ? index - 1 : null;
}

function extractMissingKeyword(error: string): { index: number; keyword: string } | null {
  const matched = /^缺少关键词 #(\d+):\s*(.+)$/.exec(error.trim());
  if (!matched) {
    return null;
  }
  const index = Number.parseInt(matched[1], 10) - 1;
  const keyword = normalizeLine(matched[2] ?? "");
  if (!Number.isFinite(index) || index < 0 || !keyword) {
    return null;
  }
  return { index, keyword };
}

function extractMissingBrand(error: string): string | null {
  const matched = /^缺少品牌词:\s*(.+)$/.exec(error.trim());
  if (!matched) {
    return null;
  }
  const brand = normalizeLine(matched[1] ?? "");
  return brand || null;
}

function extractLineLengthViolation(error: string): { index: number; violation: LengthViolation } | null {
  const matched = lineLengthErrorPattern.exec(error.trim());
  if (!matched) {
    return null;
  }
  const [, lineNo, actual, , , tolMin, tolMax] = matched;
  const index = Number.parseInt(lineNo, 10) - 1;
  if (!Number.isFinite(index) || index < 0) {
    return null;
  }
  return {
    index,
    violation: {
      actual: Number.parseInt(actual, 10),
      tolMin: Number.parseInt(tolMin, 10),
      tolMax: Number.parseInt(tolMax, 10)
    }
  };
}

function extractTextLengthViolation(error: string): LengthViolation | null {
  const matched = textLengthErrorPattern.exec(error.trim());
  if (!matched) {
    return null;
  }
  const [, actual, , , tolMin, tolMax] = matched;
  return {
    actual: Number.parseInt(actual, 10),
    tolMin: Number.parseInt(tolMin, 10),
    tolMax: Number.parseInt(tolMax, 10)
  };
}

function describeLengthDelta(violation: LengthViolation): string {
  if (violation.actual > violation.tolMax) {
    return `当前超出上限 ${violation.actual - violation.tolMax} 字符`;
  }
  if (violation.actual < violation.tolMin) {
    return `当前低于下限 ${violation.tolMin - violation.actual} 字符`;
  }
  return "当前长度已落在容差区间";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildAdaptiveSlotLengthBudgets(keywordPlan: string[][], minChars: number, maxChars: number): SlotLengthBudget[] {
  if (keywordPlan.length === 0) {
    return [];
  }
  if (minChars <= 0 || maxChars <= 0 || minChars >= maxChars) {
    return [];
  }
  const keywordTotals = keywordPlan.map((keywords) => keywords.reduce((sum, keyword) => sum + normalizeLine(keyword).length, 0));
  const average = keywordTotals.reduce((sum, value) => sum + value, 0) / keywordTotals.length;
  const midpointBase = Math.round((minChars + maxChars) / 2);
  const halfSpan = clamp(Math.floor((maxChars - minChars) / 3), 10, 16);
  return keywordTotals.map((total) => {
    const midpoint = clamp(Math.round(midpointBase + (average - total) / 2), minChars + halfSpan, maxChars - halfSpan);
    const load = total >= average + 8 ? "heavy" : total <= average - 8 ? "light" : undefined;
    return {
      min: clamp(midpoint - halfSpan, minChars, maxChars),
      max: clamp(midpoint + halfSpan, minChars, maxChars),
      load
    };
  });
}

function resolvePreferredPerLineRange(rule: SectionRule): { min: number; max: number } {
  const preferredMin = getNumber(rule.constraints, "preferred_min_chars_per_line", 0);
  const preferredMax = getNumber(rule.constraints, "preferred_max_chars_per_line", 0);
  if (preferredMin > 0 && preferredMax >= preferredMin) {
    return { min: preferredMin, max: preferredMax };
  }
  return {
    min: getNumber(rule.constraints, "min_chars_per_line", 0),
    max: getNumber(rule.constraints, "max_chars_per_line", 0)
  };
}

function resolveBulletRepairTargetRange(rule: SectionRule): { min: number; max: number } {
  const preferred = resolvePreferredPerLineRange(rule);
  if (preferred.min > 0 || preferred.max > 0) {
    return preferred;
  }
  const tolerance = getNumber(rule.constraints, "tolerance_chars", 0);
  const min = getNumber(rule.constraints, "min_chars_per_line", 0);
  const rawMax = getNumber(rule.constraints, "max_chars_per_line", 0);
  return {
    min,
    max: rawMax > 0 ? rawMax + tolerance : 0
  };
}

function buildSlotLengthBudgets(rule: SectionRule, keywordPlan: string[][]): SlotLengthBudget[] {
  if (rule.section !== "bullets") {
    return [];
  }
  const preferred = resolvePreferredPerLineRange(rule);
  return buildAdaptiveSlotLengthBudgets(
    keywordPlan,
    preferred.min,
    preferred.max
  );
}

function buildDescriptionParagraphBudgets(rule: SectionRule, slotCount: number, keywordPlan: string[][]): SlotLengthBudget[] {
  if (rule.section !== "description" || slotCount <= 0) {
    return [];
  }
  const minChars = getNumber(rule.constraints, "min_chars", 0);
  const maxChars = getNumber(rule.constraints, "max_chars", 0);
  if (minChars <= 0 || maxChars <= 0 || minChars >= maxChars) {
    return [];
  }
  return buildAdaptiveSlotLengthBudgets(
    keywordPlan,
    Math.floor(minChars / slotCount),
    Math.ceil(maxChars / slotCount)
  );
}

function describeBudgetNote(scope: "条" | "段", budget: SlotLengthBudget): string {
  if (budget.load === "heavy") {
    return `本${scope}关键词较长，正文更紧凑。`;
  }
  if (budget.load === "light") {
    return `本${scope}关键词较短，可补足细节。`;
  }
  return "";
}

function formatRangeText(min: number, max: number): string {
  if (min > 0 && max > 0) {
    return `${min}-${max}`;
  }
  if (min > 0) {
    return `至少 ${min}`;
  }
  if (max > 0) {
    return `不超过 ${max}`;
  }
  return "不限制";
}

function readHeadingWordRange(rule: SectionRule): { min: number; max: number } {
  return {
    min: getNumber(rule.constraints, "heading_min_words", 0),
    max: getNumber(rule.constraints, "heading_max_words", 0)
  };
}

function keywordCountsBySlot(total: number, slotCount: number): number[] {
  if (total <= 0 || slotCount <= 0) {
    return [];
  }
  const base = Math.floor(total / slotCount);
  const extra = total % slotCount;
  return Array.from({ length: slotCount }, (_value, index) => base + (index < extra ? 1 : 0));
}

function keywordIndexToLine(counts: number[], keywordIndex: number): number | null {
  if (keywordIndex < 0) {
    return null;
  }
  let cursor = 0;
  for (let lineIndex = 0; lineIndex < counts.length; lineIndex += 1) {
    const next = cursor + counts[lineIndex];
    if (keywordIndex < next) {
      return lineIndex;
    }
    cursor = next;
  }
  return null;
}

function resolveSectionSlotCount(rule: SectionRule): number {
  const lineCount = getNumber(rule.constraints, "line_count", 0);
  if (lineCount > 0) {
    return lineCount;
  }
  const paragraphCount = getNumber(rule.constraints, "min_paragraphs", 0);
  const maxParagraphs = getNumber(rule.constraints, "max_paragraphs", 0);
  if (paragraphCount > 0 && paragraphCount === maxParagraphs) {
    return paragraphCount;
  }
  const executionParagraphs = typeof rule.execution.paragraph_count === "number" && Number.isFinite(rule.execution.paragraph_count)
    ? Math.floor(rule.execution.paragraph_count)
    : 0;
  return executionParagraphs > 0 ? executionParagraphs : 0;
}

export function buildSectionKeywordPlan(requirements: ListingRequirements, rule: SectionRule): string[][] {
  const slotCount = resolveSectionSlotCount(rule);
  const keywordEmbedding = readKeywordEmbeddingConfig(rule.constraints);
  if (!keywordEmbedding.enabled || keywordEmbedding.minTotal <= 0 || slotCount <= 0) {
    return [];
  }
  const keywords = requirements.keywords
    .map((item) => formatGuidanceKeyword(item, keywordEmbedding.lowercase))
    .filter(Boolean);
  const target = Math.min(keywordEmbedding.minTotal, keywords.length);
  if (target <= 0) {
    return [];
  }
  const counts = keywordCountsBySlot(target, slotCount);
  const plan: string[][] = [];
  let cursor = 0;
  for (const count of counts) {
    plan.push(keywords.slice(cursor, cursor + count));
    cursor += count;
  }
  return plan;
}

export function buildSectionExecutionGuidance(requirements: ListingRequirements, rule: SectionRule): string {
  const plan = buildSectionKeywordPlan(requirements, rule);
  const slotCount = resolveSectionSlotCount(rule);
  const keywordEmbedding = readKeywordEmbeddingConfig(rule.constraints);
  const tolerance = getNumber(rule.constraints, "tolerance_chars", 0);
  const headingWords = readHeadingWordRange(rule);
  const lineMin = getNumber(rule.constraints, "min_chars_per_line", 0);
  const rawLineMax = getNumber(rule.constraints, "max_chars_per_line", 0);
  const lineMax = rawLineMax > 0 ? rawLineMax + tolerance : 0;
  const totalMin = getNumber(rule.constraints, "min_chars", 0);
  const rawTotalMax = getNumber(rule.constraints, "max_chars", 0);
  const totalMax = rawTotalMax > 0 ? rawTotalMax + tolerance : 0;
  const sentenceCount = typeof rule.execution.sentence_count === "number" && Number.isFinite(rule.execution.sentence_count)
    ? Math.floor(rule.execution.sentence_count)
    : 0;
  const slotLabel = rule.section === "description" ? "段" : "条";
  const lines = [`${rule.section} 结构化执行要求:`];

  if (slotCount > 0) {
    if (rule.section === "description") {
      lines.push(`- 固定输出 ${slotCount} 段，仅保留 1 个空行分段。`);
    } else {
      lines.push(`- 固定输出 ${slotCount} 条。`);
    }
  }
  if (rule.section === "title") {
    lines.push("- 输出单行标题文本。");
  }
  if (headingWords.min > 0 || headingWords.max > 0) {
    lines.push(`- 每条小标题词数控制在 ${formatRangeText(headingWords.min, headingWords.max)} 个英文单词。`);
  }
  if (sentenceCount > 0 && slotCount > 0) {
    lines.push(`- 当前 execution 配置总句数 ${sentenceCount}，请按 ${slotCount} 个输出槽位均匀分配。`);
  }
  if (lineMin > 0 || lineMax > 0) {
    lines.push(`- 每条长度控制在 ${formatRangeText(lineMin, lineMax)} 字符。`);
  }
  if (totalMin > 0 || totalMax > 0) {
    lines.push(`- 整体长度控制在 ${formatRangeText(totalMin, totalMax)} 字符。`);
  }
  if (rule.constraints.require_complete_sentence_end === true) {
    lines.push(`- 每${slotLabel}必须以完整句和句末标点收尾。`);
  }
  if (rule.constraints.forbid_dangling_tail === true) {
    lines.push(`- 每${slotLabel}禁止半截句尾词。`);
  }
  if (keywordEmbedding.enabled && keywordEmbedding.minTotal > 0) {
    lines.push(
      keywordEmbedding.enforceOrder
        ? `- 前 ${keywordEmbedding.minTotal} 个关键词必须按关键词库顺序出现。`
        : `- 前 ${keywordEmbedding.minTotal} 个关键词必须全部出现。`
    );
    if (keywordEmbedding.lowercase) {
      lines.push("- 关键词出现时必须保持小写。");
    }
    if ((rule.constraints.keyword_embedding as Record<string, unknown> | undefined)?.bold_wrapper === true) {
      lines.push("- 关键词必须使用 Markdown 粗体包裹。");
      lines.push("- 长度统计时，连续的 2 个星号 ** 不计入字符数。");
    }
    if (keywordEmbedding.enforceOrder && plan.length > 0) {
      lines.push(`- 按以下${slotLabel}级关键词批次依次消化，不要打乱顺序。`);
      lines.push(
        ...plan
          .filter((keywords) => keywords.length > 0)
          .map((keywords, index) => `- 第${index + 1}${slotLabel}关键词批次: ${keywords.map((item) => `**${item}**`).join(" -> ")}`)
      );
    }
  }

  const budgets = rule.section === "description"
    ? buildDescriptionParagraphBudgets(rule, slotCount, plan)
    : buildSlotLengthBudgets(rule, plan);
  for (const [index, budget] of budgets.entries()) {
    const note = describeBudgetNote(slotLabel, budget);
    lines.push(`- 第${index + 1}${slotLabel}建议长度 ${budget.min}-${budget.max} 字符${note ? `；${note}` : "。"} `);
  }

  return lines.filter(Boolean).map((line) => line.trim()).join("\n");
}

export function buildSectionRepairGuidance(
  requirements: ListingRequirements,
  rule: SectionRule,
  errors: string[]
): string {
  if (errors.length === 0) {
    return "";
  }
  const slotCount = resolveSectionSlotCount(rule);
  const lineCount = getNumber(rule.constraints, "line_count", 0);
  const repairTarget = resolveBulletRepairTargetRange(rule);
  const minTotalChars = getNumber(rule.constraints, "min_chars", 0);
  const maxTotalChars = getNumber(rule.constraints, "max_chars", 0);
  const tolerance = getNumber(rule.constraints, "tolerance_chars", 0);
  const hardTotalMax = maxTotalChars > 0 ? maxTotalChars + tolerance : 0;
  const keywordEmbedding = readKeywordEmbeddingConfig(rule.constraints);
  const keywordPlan = buildSectionKeywordPlan(requirements, rule);
  const slotBudgets = buildSlotLengthBudgets(rule, keywordPlan);
  const paragraphBudgets = buildDescriptionParagraphBudgets(rule, slotCount, keywordPlan);
  const headingWords = readHeadingWordRange(rule);
  const lineViolations = new Map<number, LengthViolation>(
    errors
      .map((error) => extractLineLengthViolation(error))
      .filter((value): value is { index: number; violation: LengthViolation } => value !== null)
      .map((item) => [item.index, item.violation])
  );
  const totalViolation = errors
    .map((error) => extractTextLengthViolation(error))
    .find((value): value is LengthViolation => value !== null);
  const counts = keywordCountsBySlot(
    Math.min(
      readKeywordEmbeddingConfig(rule.constraints).minTotal,
      requirements.keywords.map((item) => normalizeLine(item)).filter(Boolean).length
    ),
    slotCount
  );
  const lineIndexes = uniqueSorted(errors.map((error) => extractLineErrorIndex(error)).filter((value): value is number => value !== null));
  const paragraphIndexes = uniqueSorted(errors.map((error) => extractParagraphErrorIndex(error)).filter((value): value is number => value !== null));
  const keywordErrorIndex = errors
    .map((error) => extractKeywordErrorIndex(error))
    .find((value): value is number => value !== null);
  const keywordLineIndex = keywordErrorIndex === undefined ? null : keywordIndexToLine(counts, keywordErrorIndex);
  const hasParagraphCountError = errors.some((error) => error.startsWith("段落数量不满足约束:"));
  const missingKeywords = errors
    .map((error) => extractMissingKeyword(error))
    .filter((value): value is { index: number; keyword: string } => value !== null)
    .sort((left, right) => left.index - right.index);
  const missingBrand = errors
    .map((error) => extractMissingBrand(error))
    .find((value): value is string => value !== null);
  const slotLabel = rule.section === "description" ? "段" : "条";
  const lines = ["修复指导:", "- 只修复被报错的约束；未报错内容尽量保持不变。"];

  if (lineCount > 0) {
    lines.push(`- 固定输出 ${lineCount} 条。`);
  }
  if (rule.section === "description" && slotCount > 0) {
    lines.push(`- 固定输出 ${slotCount} 段，仅保留 1 个空行分段。`);
  }
  if (rule.section === "title") {
    lines.push("- 输出单行标题文本。");
  }
  if (headingWords.min > 0 || headingWords.max > 0) {
    lines.push(`- 每条小标题词数控制在 ${formatRangeText(headingWords.min, headingWords.max)} 个英文单词。`);
  }
  if (minTotalChars > 0 || maxTotalChars > 0) {
    lines.push(`- 整体长度控制在 ${formatRangeText(minTotalChars, hardTotalMax > 0 ? hardTotalMax : maxTotalChars)} 字符。`);
  }
  if (repairTarget.min > 0 || repairTarget.max > 0) {
    lines.push(`- 单条修复时，目标长度控制在 ${formatRangeText(repairTarget.min, repairTarget.max)} 字符。`);
  }
  if (rule.constraints.require_complete_sentence_end === true) {
    lines.push(`- 每${slotLabel}必须以完整句和句末标点收尾。`);
  }
  if (rule.constraints.forbid_dangling_tail === true) {
    lines.push(`- 每${slotLabel}禁止半截句尾词。`);
  }
  if (keywordEmbedding.lowercase) {
    lines.push("- 关键词出现时必须保持小写。");
  }
  if ((rule.constraints.keyword_embedding as Record<string, unknown> | undefined)?.bold_wrapper === true) {
    lines.push("- 关键词必须使用 Markdown 粗体包裹。");
    lines.push("- 长度统计时，连续的 2 个星号 ** 不计入字符数。");
  }
  if (missingBrand) {
    lines.push(`- 必须补回缺失品牌词：${missingBrand}。`);
  }
  if (totalViolation) {
    lines.push(`- ${describeLengthDelta(totalViolation)}。`);
    if (rule.section === "description" && paragraphBudgets.length > 0) {
      const targetBudget = paragraphBudgets[Math.min(Math.max(slotCount - 1, 0), paragraphBudgets.length - 1)];
      lines.push(`- 第${Math.min(slotCount, paragraphBudgets.length)}段优先收敛到建议长度 ${targetBudget.min}-${targetBudget.max} 字符。`);
    }
  }
  if (hasParagraphCountError && slotCount > 0) {
    lines.push(`- 段落数量需要调整到 ${slotCount} 段。`);
  }
  for (const paragraphIndex of paragraphIndexes) {
    lines.push(`- 第${paragraphIndex + 1}段必须以完整句和句末标点收尾。`);
  }
  for (const lineIndex of lineIndexes) {
    if (repairTarget.min > 0 && repairTarget.max > 0) {
      lines.push(`- 第${lineIndex + 1}条修复到 ${repairTarget.min}-${repairTarget.max} 字符。`);
    }
    const budget = slotBudgets[lineIndex];
    if (budget) {
      lines.push(`- 第${lineIndex + 1}条优先收敛到建议长度 ${budget.min}-${budget.max} 字符。`);
    }
    const violation = lineViolations.get(lineIndex);
    if (violation) {
      if (violation.actual < violation.tolMin) {
        lines.push(`- 第${lineIndex + 1}条${describeLengthDelta(violation)}，请补足到目标区间。`);
      } else {
        lines.push(`- 第${lineIndex + 1}条${describeLengthDelta(violation)}，请压缩到目标区间。`);
      }
    }
  }
  if ((!keywordEmbedding.enabled || !keywordEmbedding.enforceOrder) && missingKeywords.length > 0) {
    lines.push(`- 必须补回缺失关键词：${missingKeywords.map((item) => item.keyword).join(" -> ")}。`);
  }
  if (keywordEmbedding.enforceOrder && keywordPlan.length > 0) {
    const startLine = keywordLineIndex ?? 0;
    lines.push(`- 从第${startLine + 1}${slotLabel}开始按既定关键词顺序修复，前面已满足顺序的内容尽量不动。`);
    for (let index = startLine; index < keywordPlan.length; index += 1) {
      const keywords = keywordPlan[index];
      if (keywords.length === 0) {
        continue;
      }
      lines.push(`- 第${index + 1}${slotLabel}关键词批次: ${keywords.map((item) => `**${item}**`).join(" -> ")}`);
    }
  }
  return lines.join("\n");
}
