import { join } from "node:path";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { ListingResult } from "../domain/types.js";
import { LLMClient } from "./llm-client.js";
import { parseRequirements, type ListingRequirements } from "./requirements-parser.js";
import { loadTenantRules, type SectionRule } from "./rules-loader.js";

interface GenerationInput {
  tenantId: string;
  rulesVersion: string;
  inputMarkdown: string;
}

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

function validateTitle(title: string, requirements: ListingRequirements, rule: SectionRule): string[] {
  const constraints = rule.constraints;
  const tolerance = getTolerance(constraints);
  const minChars = getNumber(constraints, "min_chars", 0) - tolerance;
  const maxChars = getNumber(constraints, "max_chars", 0) + tolerance;

  const errors: string[] = [];
  const normalized = normalizeLine(title);

  if (!rangeCheck(normalized.length, Math.max(0, minChars), maxChars)) {
    errors.push(`标题长度不满足约束: ${normalized.length}`);
  }

  const mustContain = constraints.must_contain;
  if (Array.isArray(mustContain)) {
    const content = normalized.toLowerCase();
    if (mustContain.includes("brand") && requirements.brand && !content.includes(requirements.brand.toLowerCase())) {
      errors.push(`标题缺少品牌词: ${requirements.brand}`);
    }
    if (mustContain.includes("top_keywords")) {
      const topN = Math.min(3, requirements.keywords.length);
      for (let i = 0; i < topN; i += 1) {
        const kw = requirements.keywords[i];
        if (kw && !content.includes(kw.toLowerCase())) {
          errors.push(`标题缺少关键词 #${i + 1}: ${kw}`);
        }
      }
    }
  }

  return errors;
}

function validateBullets(lines: string[], rule: SectionRule): string[] {
  const constraints = rule.constraints;
  const tolerance = getTolerance(constraints);
  const expectedCount = getNumber(constraints, "line_count", 5);
  const minChars = getNumber(constraints, "min_chars_per_line", 0) - tolerance;
  const maxChars = getNumber(constraints, "max_chars_per_line", 0) + tolerance;

  const errors: string[] = [];
  if (expectedCount > 0 && lines.length !== expectedCount) {
    errors.push(`五点数量错误: ${lines.length} != ${expectedCount}`);
    return errors;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = normalizeLine(lines[i]);
    const ok = rangeCheck(line.length, Math.max(0, minChars), maxChars);
    if (!ok) {
      errors.push(`第${i + 1}条长度不满足约束: ${line.length}`);
    }
  }

  return errors;
}

function validateDescription(text: string, rule: SectionRule): string[] {
  const constraints = rule.constraints;
  const tolerance = getTolerance(constraints);
  const minChars = getNumber(constraints, "min_chars", 0) - tolerance;
  const maxChars = getNumber(constraints, "max_chars", 0) + tolerance;

  const normalized = normalizeText(text);
  const errors: string[] = [];

  if (!rangeCheck(normalized.length, Math.max(0, minChars), maxChars)) {
    errors.push(`描述长度不满足约束: ${normalized.length}`);
  }

  const paragraphs = normalized
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const minParagraphs = getNumber(constraints, "min_paragraphs", 0);
  const maxParagraphs = getNumber(constraints, "max_paragraphs", 0);

  if (!rangeCheck(paragraphs.length, minParagraphs, maxParagraphs)) {
    errors.push(`段落数量不满足约束: ${paragraphs.length}`);
  }

  return errors;
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

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger
  ) {
    this.llmClient = new LLMClient(env, logger);
  }

  private buildSectionSystemPrompt(rule: SectionRule): string {
    return [
      "你是专业亚马逊 Listing 文案专家。",
      "只输出目标 section 的文本，不要输出解释、JSON、代码块、前后缀。",
      `section=${rule.section}`,
      `规则:\n${rule.instruction}`
    ].join("\n");
  }

  private buildSectionUserPrompt(requirements: ListingRequirements, section: string, extra?: string): string {
    const keywords = requirements.keywords.join("\n");
    return [
      `任务: 生成 section=${section}（英文）`,
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${keywords}`,
      "输入需求原文:",
      requirements.raw,
      extra ? `\n修正反馈:\n${extra}` : ""
    ].join("\n");
  }

  private async generateSectionWithValidation(
    requirements: ListingRequirements,
    rule: SectionRule,
    step: string,
    validate: (content: string) => string[]
  ): Promise<string> {
    const retries = Math.max(1, rule.execution.retries || 3);
    let feedback = "";

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const content = await this.llmClient.generateWithFluxcode(
        this.buildSectionSystemPrompt(rule),
        this.buildSectionUserPrompt(requirements, rule.section, feedback),
        `${step}_attempt_${attempt}`,
        2
      );

      const normalized = normalizeText(content);
      const errors = validate(normalized);
      if (errors.length === 0) {
        return normalized;
      }

      feedback = errors.map((err) => `- ${err}`).join("\n");
      this.logger.warn(
        { event: "validate_fail", step, attempt, errors },
        "validation failed"
      );

      if (attempt >= retries) {
        throw new Error(`${step} 重试后仍失败: ${errors.join("; ")}`);
      }
    }

    throw new Error(`${step} 未生成有效内容`);
  }

  private async translateText(text: string, step: string, retries: number): Promise<string> {
    return this.llmClient.translateWithDeepseek(
      "你是专业翻译。将输入英文翻译成简体中文，保持语义准确，不要解释。",
      text,
      step,
      Math.max(1, retries)
    );
  }

  async generate(input: GenerationInput): Promise<ListingResult> {
    const start = Date.now();
    const requirements = parseRequirements(input.inputMarkdown);

    if (!requirements.category) {
      throw new Error("缺少分类")
    }
    if (requirements.keywords.length < 3) {
      throw new Error("关键词过少，至少 3 条");
    }

    const archivePath = join(this.env.rulesFsDir, input.tenantId, input.rulesVersion, "rules.tar.gz");
    const tenantRules = await loadTenantRules(archivePath, input.tenantId, input.rulesVersion);

    const titleRule = tenantRules.sections.get("title");
    const bulletsRule = tenantRules.sections.get("bullets");
    const descriptionRule = tenantRules.sections.get("description");
    const searchTermsRule = tenantRules.sections.get("search_terms");
    const translationRule = tenantRules.sections.get("translation");

    if (!titleRule || !bulletsRule || !descriptionRule || !searchTermsRule || !translationRule) {
      throw new Error("规则文件缺失：title/bullets/description/search_terms/translation 必须齐全");
    }

    const translationRetries = Math.max(1, translationRule.execution.retries || 2);

    const categoryTranslationPromise = this.translateText(requirements.category, "translate_category", translationRetries);
    const keywordsText = requirements.keywords.join("\n");
    const keywordsTranslationPromise = this.translateText(keywordsText, "translate_keywords", translationRetries);

    const titleEn = await this.generateSectionWithValidation(requirements, titleRule, "title", (content) =>
      validateTitle(content, requirements, titleRule)
    );
    const titleCnPromise = this.translateText(titleEn, "translate_title", translationRetries);

    const bulletsRaw = await this.generateSectionWithValidation(requirements, bulletsRule, "bullets", (content) => {
      const lines = splitLines(content);
      return validateBullets(lines, bulletsRule);
    });
    const bulletsLinesEn = splitLines(bulletsRaw);
    const bulletsCnPromise = this.translateText(bulletsLinesEn.join("\n"), "translate_bullets", translationRetries);

    const descriptionEn = await this.generateSectionWithValidation(requirements, descriptionRule, "description", (content) =>
      validateDescription(content, descriptionRule)
    );
    const descriptionCnPromise = this.translateText(descriptionEn, "translate_description", translationRetries);

    const searchTermsEn = dedupeKeepOrder(requirements.keywords).join(" ");
    const searchTermsCnPromise = this.translateText(searchTermsEn, "translate_search_terms", translationRetries);

    const categoryCn = await promiseValue(categoryTranslationPromise, "分类翻译");
    const keywordsCnRaw = await promiseValue(keywordsTranslationPromise, "关键词翻译");
    const titleCn = await promiseValue(titleCnPromise, "标题翻译");
    const bulletsCnRaw = await promiseValue(bulletsCnPromise, "五点翻译");
    const descriptionCn = await promiseValue(descriptionCnPromise, "描述翻译");
    const searchTermsCn = await promiseValue(searchTermsCnPromise, "搜索词翻译");

    const keywordsCn = splitLines(keywordsCnRaw);
    const bulletsCn = splitLines(bulletsCnRaw);

    const enMarkdown = [
      "# Amazon Listing (EN)",
      "",
      "## 分类",
      requirements.category,
      "",
      "## 关键词",
      ...requirements.keywords,
      "",
      "## 标题",
      titleEn,
      "",
      "## 五点描述",
      ...bulletsLinesEn.map((line, idx) => `**第${idx + 1}点**\n${line}\n`),
      "",
      "## 产品描述",
      descriptionEn,
      "",
      "## 搜索词",
      searchTermsEn
    ].join("\n");

    const cnMarkdown = [
      "# 亚马逊 Listing (CN)",
      "",
      "## 分类",
      normalizeText(categoryCn),
      "",
      "## 关键词",
      ...(keywordsCn.length > 0 ? keywordsCn : requirements.keywords),
      "",
      "## 标题",
      normalizeText(titleCn),
      "",
      "## 五点描述",
      ...(bulletsCn.length > 0
        ? bulletsCn.map((line, idx) => `**第${idx + 1}点**\n${line}\n`)
        : bulletsLinesEn.map((line, idx) => `**第${idx + 1}点**\n${line}\n`)),
      "",
      "## 产品描述",
      normalizeText(descriptionCn),
      "",
      "## 搜索词",
      normalizeText(searchTermsCn)
    ].join("\n");

    return {
      en_markdown: enMarkdown,
      cn_markdown: cnMarkdown,
      validation_report: [
        `rules_version=${tenantRules.version}`,
        `keywords_count=${requirements.keywords.length}`,
        `bullets_count=${bulletsLinesEn.length}`
      ],
      timing_ms: Date.now() - start,
      billing_summary: {
        provider: "fluxcode+deepseek",
        model: `${this.env.fluxcodeModel}+${this.env.deepseekModel}`,
        note: "english generation + chinese translation"
      }
    };
  }
}
