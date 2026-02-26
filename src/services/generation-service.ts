import { join } from "node:path";
import type { ModelSettings } from "@openai/agents";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { ListingResult } from "../domain/types.js";
import { LLMClient } from "./llm-client.js";
import { parseRequirements, type ListingRequirements } from "./requirements-parser.js";
import { loadTenantRules, type SectionRule } from "./rules-loader.js";
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

function adaptBulletsJSONContent(raw: string): { content: string; error?: string } {
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
  const bullets = (parsed as { bullets?: unknown }).bullets;
  if (!Array.isArray(bullets)) {
    return { content: "", error: "JSON 解析失败: 缺少 bullets 数组字段" };
  }
  const lines = bullets
    .map((item) => (typeof item === "string" ? normalizeLine(stripBulletPrefix(item)) : ""))
    .filter(Boolean);
  if (lines.length === 0) {
    return { content: "", error: "JSON 解析失败: bullets 数组为空" };
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

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
    private readonly traceStore: RedisTraceStore,
    private readonly traceContext: { tenantId: string; jobId: string }
  ) {
    this.llmClient = new LLMClient(env, logger, traceStore, traceContext);
  }

  private async appendTrace(
    event: string,
    level: "info" | "warn" | "error" = "info",
    payload?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.traceStore.append({
        ts: new Date().toISOString(),
        source: "generation",
        event,
        level,
        tenant_id: this.traceContext.tenantId,
        job_id: this.traceContext.jobId,
        payload
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

  private buildSectionSystemPrompt(rule: SectionRule, jsonOutput = false): string {
    return [
      "你是专业亚马逊 Listing 文案专家。",
      jsonOutput
        ? "只输出符合要求的 JSON 对象，不要解释，不要代码块，不要额外文本。"
        : "只输出目标 section 的文本，不要输出解释、JSON、代码块、前后缀。",
      `section=${rule.section}`,
      `规则:\n${rule.instruction}`
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
    return rule.execution.repair_mode === "item" && rule.output.format === "lines";
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
    return [
      "你是专业亚马逊 Listing 文案专家。",
      "你正在修复单条文案。",
      "只输出修复后的单行英文文本，不要编号，不要项目符号，不要解释，不要换行。",
      `section=${rule.section}`,
      `target_line=${targetIndex + 1}`,
      `line_length=${this.lineCharRangeText(rule)}`,
      `规则:\n${rule.instruction}`
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
      lineErrors.length > 0 ? `该行校验错误:\n${lineErrors.map((v) => `- ${v}`).join("\n")}` : "",
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
        lines[idx] = normalizeLine(stripBulletPrefix(repaired));
      }

      const merged = lines.join("\n");
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
      `校验错误:\n${errors.map((v) => `- ${v}`).join("\n")}`,
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

      if (this.supportsItemRepair(rule)) {
        await this.appendTrace("section_repair_needed", "warn", {
          step,
          section: rule.section,
          repair_mode: "item",
          errors
        });
        this.logger.warn(
          {
            event: "section_repair_needed",
            step,
            section: rule.section,
            repair_mode: "item",
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

      feedback = errors.map((err) => `- ${err}`).join("\n");
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
    const started = Date.now();
    await this.appendTrace("translate_start", "info", { step, input_chars: text.length, retries });
    this.logger.info({ event: "translate_start", step, input_chars: text.length, retries }, "translate start");
    const translated = await this.llmClient.translateWithTranslatorAgent(
      "你是专业翻译。将输入英文翻译成简体中文，保持语义准确，不要解释。",
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

  private buildPlanningSystemPrompt(): string {
    return [
      "你是电商文案执行编排师（Orchestrator）。",
      "请根据输入需求输出一份简洁的英文执行简报，用于后续多阶段文案生成与修复。",
      "只输出纯文本，不要 JSON，不要代码块，不要解释过程。"
    ].join("\n");
  }

  private buildPlanningUserPrompt(requirements: ListingRequirements): string {
    return [
      "任务：输出 listing 生成执行简报（英文）",
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${requirements.keywords.join("\n")}`,
      "需求原文:",
      requirements.raw,
      "输出要求：",
      "1) 给出标题策略、五点策略、描述策略、搜索词策略；",
      "2) 给出执行顺序建议（先并发生成哪些 section，再做哪些复核）；",
      "3) 每条策略一句话，强调关键词覆盖与可读性平衡；",
      "4) 总长度控制在 700 字符以内。"
    ].join("\n");
  }

  private async planExecution(requirements: ListingRequirements): Promise<string> {
    const started = Date.now();
    await this.appendTrace("planning_start", "info", {
      brand: requirements.brand,
      category: requirements.category,
      keywords_count: requirements.keywords.length
    });
    try {
      const brief = await this.llmClient.orchestrateWithOrchestratorAgent(
        this.buildPlanningSystemPrompt(),
        this.buildPlanningUserPrompt(requirements),
        "orchestration",
        2
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

  private buildJudgeSystemPrompt(): string {
    return [
      "你是亚马逊 Listing 质量审查专家。",
      "你将审查英文 listing 各 section 的一致性与规则匹配度。",
      "若无问题，只输出：OK",
      "若有问题，按以下格式逐行输出：",
      "- [title] <问题>",
      "- [bullets] <问题>",
      "- [description] <问题>",
      "- [search_terms] <问题>",
      "禁止输出其他格式。"
    ].join("\n");
  }

  private buildJudgeUserPrompt(requirements: ListingRequirements, sections: Record<ENSectionKey, string>): string {
    return [
      `品牌: ${requirements.brand}`,
      `分类: ${requirements.category}`,
      `关键词库:\n${requirements.keywords.join("\n")}`,
      "",
      "【TITLE】",
      sections.title,
      "",
      "【BULLETS】",
      sections.bullets,
      "",
      "【DESCRIPTION】",
      sections.description,
      "",
      "【SEARCH_TERMS】",
      sections.search_terms
    ].join("\n");
  }

  private parseJudgeIssues(text: string): JudgeIssue[] {
    const normalized = normalizeText(text);
    if (normalized.toUpperCase() === "OK") {
      return [];
    }
    const lines = normalized.split("\n").map((v) => v.trim()).filter(Boolean);
    const out: JudgeIssue[] = [];
    for (const line of lines) {
      const m = /^-?\s*\[(title|bullets|description|search_terms)\]\s*(.+)$/i.exec(line);
      if (!m) {
        continue;
      }
      out.push({
        section: m[1].toLowerCase() as ENSectionKey,
        message: m[2].trim()
      });
    }
    return out;
  }

  private async runQualityJudge(
    requirements: ListingRequirements,
    sections: Record<ENSectionKey, string>
  ): Promise<JudgeIssue[]> {
    const started = Date.now();
    await this.appendTrace("quality_judge_start", "info", {});
    try {
      const judgeOutput = await this.llmClient.reviewWithJudgeAgent(
        this.buildJudgeSystemPrompt(),
        this.buildJudgeUserPrompt(requirements, sections),
        "quality_judge",
        2
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
    const requirements = parseRequirements(input.inputMarkdown);

    if (!requirements.category) {
      await this.appendTrace("generation_invalid_input", "error", { error: "缺少分类" });
      throw new Error("缺少分类");
    }
    if (requirements.keywords.length < 3) {
      await this.appendTrace("generation_invalid_input", "error", { error: "关键词过少，至少 3 条" });
      throw new Error("关键词过少，至少 3 条");
    }

    const archivePath = join(this.env.rulesFsDir, input.tenantId, input.rulesVersion, "rules.tar.gz");
    const tenantRules = await loadTenantRules(archivePath, input.tenantId, input.rulesVersion);
    await this.appendTrace("rules_loaded", "info", {
      archive_path: archivePath,
      rules_version: tenantRules.version
    });

    const titleRule = tenantRules.sections.get("title");
    const bulletsRule = tenantRules.sections.get("bullets");
    const descriptionRule = tenantRules.sections.get("description");
    const searchTermsRule = tenantRules.sections.get("search_terms");
    const translationRule = tenantRules.sections.get("translation");

    if (!titleRule || !bulletsRule || !descriptionRule || !searchTermsRule || !translationRule) {
      await this.appendTrace("rules_missing_sections", "error", {
        title: Boolean(titleRule),
        bullets: Boolean(bulletsRule),
        description: Boolean(descriptionRule),
        search_terms: Boolean(searchTermsRule),
        translation: Boolean(translationRule)
      });
      throw new Error("规则文件缺失：title/bullets/description/search_terms/translation 必须齐全");
    }

    const translationRetries = Math.max(1, translationRule.execution.retries || 2);
    this.executionBrief = await this.planExecution(requirements);

    const categoryTranslationPromise = this.translateText(requirements.category, "translate_category", translationRetries);
    const keywordsText = requirements.keywords.join("\n");
    const keywordsTranslationPromise = this.translateText(keywordsText, "translate_keywords", translationRetries);

    const titleEnPromise = this.generateSectionWithValidation(requirements, titleRule, "title", (content) =>
      validateTitle(content, requirements, titleRule)
    );
    const bulletsJSONModeSettings = this.deepseekJSONModeSettings();
    const bulletsRawPromise = this.generateSectionWithValidation(requirements, bulletsRule, "bullets", (content) => {
      const lines = splitLines(content);
      return validateBullets(lines, bulletsRule);
    }, {
      jsonOutput: true,
      writerModelSettings: bulletsJSONModeSettings,
      repairModelSettings: bulletsJSONModeSettings,
      adaptContent: adaptBulletsJSONContent
    });
    const descriptionEnPromise = this.generateSectionWithValidation(requirements, descriptionRule, "description", (content) =>
      validateDescription(content, descriptionRule)
    );

    let titleEn = await titleEnPromise;
    let bulletsRaw = await bulletsRawPromise;
    let bulletsLinesEn = splitLines(bulletsRaw);
    let descriptionEn = await descriptionEnPromise;

    const searchTermsEn = dedupeKeepOrder(requirements.keywords).join(" ");

    const maxJudgeRounds = 2;
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
          (content) => validateTitle(content, requirements, titleRule),
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
          (content) => validateBullets(splitLines(content), bulletsRule),
          {
            initialFeedback: this.buildJudgeFeedbackText(grouped.bullets),
            maxRetries: 2,
            jsonOutput: true,
            writerModelSettings: bulletsJSONModeSettings,
            repairModelSettings: bulletsJSONModeSettings,
            adaptContent: adaptBulletsJSONContent
          }
        );
        bulletsLinesEn = splitLines(bulletsRaw);
      }

      if (grouped.description.length > 0) {
        descriptionEn = await this.generateSectionWithValidation(
          requirements,
          descriptionRule,
          `description_judge_repair_round_${judgeRound}`,
          (content) => validateDescription(content, descriptionRule),
          {
            initialFeedback: this.buildJudgeFeedbackText(grouped.description),
            maxRetries: 2
          }
        );
      }

      if (grouped.search_terms.length > 0) {
        await this.appendTrace("quality_judge_repair_skip", "warn", {
          round: judgeRound,
          section: "search_terms",
          reason: "search_terms 固定由关键词库复制，不进行模型改写",
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
      validation_report: [
        `rules_version=${tenantRules.version}`,
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
