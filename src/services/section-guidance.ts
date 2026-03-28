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
  if (rule.section !== "bullets") {
    return resolvePreferredPerLineRange(rule);
  }
  const rawMax = getNumber(rule.constraints, "max_chars_per_line", 0);
  const tolerance = getNumber(rule.constraints, "tolerance_chars", 0);
  if (rawMax > 0) {
    const min = rawMax + 2;
    const hardMax = rawMax + tolerance;
    const max = hardMax > 0 ? Math.min(rawMax + 8, hardMax) : rawMax + 8;
    return { min, max: Math.max(min, max) };
  }
  return resolvePreferredPerLineRange(rule);
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

function buildBulletLineRoleGuidance(index: number): string {
  switch (index) {
    case 0:
      return "第1条围绕套装内容、数量和拿来即用，自拟 2-4 个单词小标题。";
    case 1:
      return "第2条不要固定写尺寸，自拟 2-4 个单词小标题，优先发掘最强产品优势。";
    case 2:
      return "第3条不要固定写材质，自拟 2-4 个单词小标题，继续补最有说服力的产品优势。";
    case 3:
      return "第4条不要固定写颜色，自拟 2-4 个单词小标题，优先补足差异化优势和视觉卖点。";
    case 4:
      return "第5条围绕适用场景与用途收束，自拟 2-4 个单词小标题，不要回头重讲前面优势。";
    default:
      return `第${index + 1}条先定小标题，再只讲本条核心信息。`;
  }
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
  const tolerance = getNumber(rule.constraints, "tolerance_chars", 0);
  const keywordEmbedding = readKeywordEmbeddingConfig(rule.constraints);
  const requiredKeywordCount = Math.min(
    keywordEmbedding.minTotal,
    requirements.keywords.map((item) => normalizeLine(item)).filter(Boolean).length
  );
  if (rule.section === "bullets") {
    if (plan.length === 0) {
      return "";
    }
    const minChars = getNumber(rule.constraints, "min_chars_per_line", 0);
    const maxChars = getNumber(rule.constraints, "max_chars_per_line", 0);
    const preferred = resolvePreferredPerLineRange(rule);
    const hardMax = maxChars > 0 ? maxChars + tolerance : 0;
    const budgets = buildSlotLengthBudgets(rule, plan);
    return [
      "Bullets 结构化执行要求:",
      "- 先写 2-4 个英文单词的小标题，再写正文；正文保持紧凑完整，不要空泛铺陈。",
      "- 每条优先 1 个主句 + 1 个短结果句；没有必要就只写 1 句，但必须写成完整句。",
      "- 每条首个关键词必须在小标题后尽快出现，再按批次顺序带入后续关键词。",
      "- 关键词一律使用小写并加粗，格式示例：**paper lanterns**。",
      "- 第2、3、4条不要套固定模版，优先发掘产品最强优点，不要机械重复尺寸/材质/颜色。",
      "- 字符数按最终文本逐字符计算，空格和标点都计入长度；连续的 2 个星号 ** 不计入字符数。",
      "- 第二句只补 1 个结果或用途，不要继续枚举多个场景、并列多个空泛卖点。",
      "- 禁止 that/which/while/allowing/providing/making/ensuring 这类拖尾扩写。",
      "- 禁止 ideal、perfect、transform、create、bring、enhance 这类空泛词。",
      "- 同一条最多保留 1 个结果或场景，不要并列 events、parties、classrooms 这类场景串。",
      "- 严格按以下批次消化关键词，不要把后续条目的关键词提前，不要跨条目打乱顺序。",
      ...plan.map((_keywords, index) => `- ${buildBulletLineRoleGuidance(index)}`),
      ...plan.map((keywords, index) => `- 第${index + 1}条关键词批次: ${keywords.map((item) => `**${item}**`).join(" -> ")}`),
      ...budgets
        .map((budget, index) => {
          const note = describeBudgetNote("条", budget);
          return `- 第${index + 1}条建议长度 ${budget.min}-${budget.max} 字符${note ? `；${note}` : "。"} `;
        })
        .map((line) => line.trim()),
      preferred.min > 0 && preferred.max > 0 ? `- 每条最佳落点 ${preferred.min}-${preferred.max} 字符，略高于 250 字符更稳妥。` : "",
      minChars > 0 ? `- 每条不得少于 ${minChars} 字符。` : "",
      hardMax > 0 ? `- 每条绝对上限 ${hardMax} 字符，超出就整条重写，不要只砍尾巴。` : ""
    ].filter(Boolean).join("\n");
  }
  if (rule.section === "description") {
    const minChars = getNumber(rule.constraints, "min_chars", 0);
    const maxChars = getNumber(rule.constraints, "max_chars", 0);
    const hardMax = maxChars > 0 ? maxChars + tolerance : 0;
    const perParagraphMin = slotCount > 0 && minChars > 0 ? Math.floor(minChars / slotCount) : 0;
    const perParagraphMax = slotCount > 0 && maxChars > 0 ? Math.ceil(maxChars / slotCount) : 0;
    const budgets = buildDescriptionParagraphBudgets(rule, slotCount, plan);
    const paragraphBudgetLines = keywordEmbedding.enforceOrder
      ? budgets
          .map((budget, index) => {
            const note = describeBudgetNote("段", budget);
            return `- 第${index + 1}段建议长度 ${budget.min}-${budget.max} 字符${note ? `；${note}` : "。"} `;
          })
          .map((line) => line.trim())
      : Array.from({ length: slotCount }, (_value, index) =>
          perParagraphMin > 0 && perParagraphMax > 0
            ? `- 第${index + 1}段建议长度 ${perParagraphMin}-${perParagraphMax} 字符。`
            : ""
        ).filter(Boolean);
    return [
      "Description 结构化执行要求:",
      `- 固定输出 ${plan.length} 段，仅保留 1 个空行分段；每段聚焦不同价值点。`,
      "- 每段控制 2-3 句，句末必须带标点，不要拆成第 3 段。",
      "- 字符数按最终文本逐字符计算，空格和标点都计入长度；连续的 2 个星号 ** 不计入字符数。",
      perParagraphMin > 0 && perParagraphMax > 0 ? `- 每段建议控制在 ${perParagraphMin}-${perParagraphMax} 字符，优先均匀分配篇幅。` : "",
      keywordEmbedding.enabled && requiredKeywordCount > 0
        ? keywordEmbedding.enforceOrder
          ? "- 严格按以下段落批次消化关键词，不要把第 2 段关键词提前到第 1 段。"
          : `- 全文自然覆盖前 ${requiredKeywordCount} 个关键词即可，不限制所在段落；关键词保持原样并使用 Markdown 粗体。`
        : "",
      ...(keywordEmbedding.enforceOrder
        ? plan.map((keywords, index) => `- 第${index + 1}段关键词批次: ${keywords.map((item) => `**${item}**`).join(" -> ")}`)
        : []),
      ...paragraphBudgetLines,
      minChars > 0 && maxChars > 0 ? `- 整体目标长度 ${minChars}-${maxChars} 字符。` : "",
      hardMax > 0 ? `- 整体绝对上限 ${hardMax} 字符，超出就整段重写，不要只砍尾巴。` : ""
    ].filter(Boolean).join("\n");
  }
  return "";
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
  const minChars = getNumber(rule.constraints, "min_chars_per_line", 0);
  const maxChars = getNumber(rule.constraints, "max_chars_per_line", 0);
  const preferred = resolvePreferredPerLineRange(rule);
  const repairTarget = resolveBulletRepairTargetRange(rule);
  const minTotalChars = getNumber(rule.constraints, "min_chars", 0);
  const maxTotalChars = getNumber(rule.constraints, "max_chars", 0);
  const tolerance = getNumber(rule.constraints, "tolerance_chars", 0);
  const hardMax = maxChars > 0 ? maxChars + tolerance : 0;
  const hardTotalMax = maxTotalChars > 0 ? maxTotalChars + tolerance : 0;
  const keywordEmbedding = readKeywordEmbeddingConfig(rule.constraints);
  const keywordPlan = buildSectionKeywordPlan(requirements, rule);
  const slotBudgets = buildSlotLengthBudgets(rule, keywordPlan);
  const paragraphBudgets = buildDescriptionParagraphBudgets(rule, slotCount, keywordPlan);
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

  if (rule.section === "title") {
    const lines = ["修复指导:", "- 标题必须保持单行，只输出标题文本。"];
    if (minTotalChars > 0 && maxTotalChars > 0) {
      lines.push(
        `- 总长度控制在 ${minTotalChars}-${maxTotalChars} 字符，${hardTotalMax > 0 ? `绝不超过 ${hardTotalMax} 字符。` : "保持长度稳定。"}`
      );
    }
    if (totalViolation) {
      lines.push(`- ${describeLengthDelta(totalViolation)}。`);
      if (totalViolation.actual > totalViolation.tolMax) {
        lines.push("- 超长时先删重复场景词、并列同义修饰和空泛形容词，不要删品牌词与前 3 条核心关键词。");
        lines.push("- 保留 1 个核心使用场景和必要规格信息，不要并列堆多个节日、场景或近义短语。");
      } else if (totalViolation.actual < totalViolation.tolMin) {
        lines.push("- 过短时优先补 1 个核心使用场景或规格信息，不要堆空泛形容词。");
      }
    }
    if (requirements.brand && errors.some((error) => error === `缺少品牌词: ${requirements.brand}`)) {
      lines.push(`- 必须补回品牌词 ${requirements.brand}，且保持自然可读。`);
    }
    const missingTopKeywords = errors
      .map((error) => extractMissingKeyword(error))
      .filter((value): value is { index: number; keyword: string } => value !== null)
      .sort((left, right) => left.index - right.index);
    const topKeywords = requirements.keywords
      .slice(0, 3)
      .map((keyword) => normalizeLine(keyword))
      .filter(Boolean);
    if (topKeywords.length > 0) {
      lines.push(`- 前 3 条核心关键词必须保持原词序自然出现：${topKeywords.join(" -> ")}。`);
    }
    if (missingTopKeywords.length > 0) {
      lines.push(`- 必须补回前 3 条核心关键词中缺失的短语：${missingTopKeywords.map((item) => item.keyword).join(" -> ")}。`);
    }
    lines.push("- 优先结构：品牌 + 核心产品词 + 关键使用场景 + 规格信息。");
    return lines.join("\n");
  }

  if (rule.section === "description") {
    const lines = ["修复指导:"];
    const requiredKeywordCount = Math.min(
      keywordEmbedding.minTotal,
      requirements.keywords.map((item) => normalizeLine(item)).filter(Boolean).length
    );
    if (slotCount > 0) {
      lines.push(`- 固定输出 ${slotCount} 段，仅保留 1 个空行分段，不要拆成额外段落。`);
    }
    if (minTotalChars > 0 && maxTotalChars > 0) {
      lines.push(
        `- 整体长度控制在 ${minTotalChars}-${maxTotalChars} 字符，${hardTotalMax > 0 ? `绝不超过 ${hardTotalMax} 字符。` : "保持总长度稳定。"}`
      );
    }
    if (slotCount > 0 && minTotalChars > 0 && maxTotalChars > 0) {
      const perParagraphMin = Math.floor(minTotalChars / slotCount);
      const perParagraphMax = Math.ceil(maxTotalChars / slotCount);
      lines.push(`- 每段建议长度 ${perParagraphMin}-${perParagraphMax} 字符。`);
    }
    if (totalViolation) {
      lines.push(`- ${describeLengthDelta(totalViolation)}。`);
      if (totalViolation.actual > totalViolation.tolMax && slotCount > 0) {
        lines.push("- 当前整体超长，先压缩再润色，不要只微调几个词。");
        lines.push("- 优先删除重复场景串、同义复述和空泛修饰，不要删品牌词和已满足的核心关键词。");
        const targetBudget = keywordEmbedding.enforceOrder ? paragraphBudgets[slotCount - 1] : null;
        if (targetBudget && keywordEmbedding.enforceOrder) {
          const note = describeBudgetNote("段", targetBudget);
          lines.push(
            `- 第${slotCount}段优先收敛到建议长度 ${targetBudget.min}-${targetBudget.max} 字符；${note || "正文保持紧凑。"}`
          );
        } else {
          const perParagraphMin = slotCount > 0 && minTotalChars > 0 ? Math.floor(minTotalChars / slotCount) : 0;
          const perParagraphMax = slotCount > 0 && maxTotalChars > 0 ? Math.ceil(maxTotalChars / slotCount) : 0;
          if (perParagraphMin > 0 && perParagraphMax > 0) {
            lines.push(`- 优先把第${slotCount}段压缩到建议长度 ${perParagraphMin}-${perParagraphMax} 字符，删除重复修饰、同义复述和非关键信息。`);
          } else {
            lines.push(`- 优先把第${slotCount}段压缩到建议长度，删除重复修饰、同义复述和非关键信息。`);
          }
        }
      } else if (totalViolation.actual < totalViolation.tolMin) {
        lines.push("- 当前整体偏短，优先补足具体产品细节、使用收益或安装体验，不要补空话。");
      }
    }
    if (hasParagraphCountError) {
      lines.push("- 先合并或重写段落结构，再细修句子和关键词，不要保留第 3 段。");
    }
    for (const paragraphIndex of paragraphIndexes) {
      lines.push(`- 第${paragraphIndex + 1}段必须以完整句和句末标点收尾。`);
    }
    if (!keywordEmbedding.enforceOrder && missingKeywords.length > 0) {
      lines.push(`- 必须补回缺失的前 ${requiredKeywordCount} 个关键词：${missingKeywords.map((item) => item.keyword).join(" -> ")}。`);
    }
    if (keywordEmbedding.enforceOrder && keywordLineIndex !== null) {
      lines.push(`- 从第${keywordLineIndex + 1}段开始按既定关键词批次重写，前面已满足顺序的段落尽量不动。`);
    }
    if (keywordEmbedding.enforceOrder && keywordPlan.length > 0) {
      const startParagraph = keywordLineIndex ?? 0;
      for (let index = startParagraph; index < keywordPlan.length; index += 1) {
        const keywords = keywordPlan[index];
        if (keywords.length === 0) {
          continue;
        }
        lines.push(`- 第${index + 1}段关键词批次: ${keywords.map((item) => `**${item}**`).join(" -> ")}`);
      }
    }
    return lines.join("\n");
  }

  const lines = [
    "修复指导:",
    "- 优先保留已通过的前序条目，只重写被点名的条目和其后的乱序条目。",
    "- 未被点名的条目尽量逐字保持原样，不要顺手改写通过的条目。",
    "- 每条小标题控制在 2-4 个英文单词，关键词一律使用小写加粗，空格和标点都计入字符数；连续的 2 个星号 ** 不计入字符数。"
  ];
  for (const lineIndex of lineIndexes) {
    if (repairTarget.min > 0 && repairTarget.max > 0) {
      lines.push(
        `- 第${lineIndex + 1}条重写到 ${repairTarget.min}-${repairTarget.max} 字符，${hardMax > 0 ? `绝不超过 ${hardMax} 字符。` : "保持长度稳定。"}`
      );
    }
    lines.push(`- ${buildBulletLineRoleGuidance(lineIndex)}`);
    lines.push(`- 第${lineIndex + 1}条只保留 1 个主句，可选 1 个极短结果句。`);
    const budget = slotBudgets[lineIndex];
    if (budget) {
      lines.push(
        `- 第${lineIndex + 1}条优先收敛到建议长度 ${budget.min}-${budget.max} 字符；${describeBudgetNote("条", budget) || "正文保持紧凑。"} `
      );
    }
    const violation = lineViolations.get(lineIndex);
    if (violation) {
      if (violation.actual < violation.tolMin) {
        lines.push(`- 第${lineIndex + 1}条${describeLengthDelta(violation)}，优先补 1 个具体产品细节或结果句。`);
        lines.push(`- 第${lineIndex + 1}条当前至少还差 ${violation.tolMin - violation.actual} 个可见字符，补完后最好落到 ${repairTarget.min}-${repairTarget.max} 字符。`);
        lines.push(`- 第${lineIndex + 1}条不要停在 230-239 这类仍会失败的长度，至少补到 ${repairTarget.min} 字符以上再停。`);
        lines.push(`- 第${lineIndex + 1}条不要只改几个词，至少补足缺少的长度，同时保持关键词顺序不变。`);
        lines.push(`- 第${lineIndex + 1}条补充数量、尺寸、安装体验、可复用性或教室场景收益这类具体信息，不要补空话。`);
      } else {
        lines.push(`- 第${lineIndex + 1}条${describeLengthDelta(violation)}，优先删除重复修饰和泛化铺陈。`);
        lines.push(`- 第${lineIndex + 1}条删掉 that/which/while/allowing/providing/making/ensuring 这类拖尾扩写。`);
        lines.push(`- 第${lineIndex + 1}条不要再补 ideal、perfect、transform、create、bring、enhance 这类空泛词。`);
      }
    }
  }
  if (keywordLineIndex !== null) {
    lines.push(`- 从第${keywordLineIndex + 1}条开始按既定关键词批次重写，前面已满足顺序的条目尽量不动。`);
    lines.push(`- 第${keywordLineIndex + 1}条中关键词必须按批次顺序首次出现，先写第1个，再写第2个，最后写第3个关键词。`);
    for (let index = keywordLineIndex; index < keywordPlan.length; index += 1) {
      lines.push(`- ${buildBulletLineRoleGuidance(index)}`);
    }
  }
  if (keywordPlan.length > 0) {
    const startLine = keywordLineIndex ?? 0;
    for (let index = startLine; index < keywordPlan.length; index += 1) {
      const keywords = keywordPlan[index];
      if (keywords.length === 0) {
        continue;
      }
      lines.push(`- 第${index + 1}条关键词批次: ${keywords.map((item) => `**${item}**`).join(" -> ")}`);
    }
  }
  return lines.join("\n");
}
