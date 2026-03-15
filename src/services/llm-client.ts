import { Agent, MemorySession, OpenAIProvider, Runner, tool, type ModelSettings } from "@openai/agents";
import type { Logger } from "pino";
import { z } from "zod";
import { buildSectionAgentTeam, type SectionAgentTeam } from "../agent-runtime/section-team.js";
import type { ModelProfile } from "../agent-runtime/types.js";
import type { AppEnv } from "../config/env.js";
import type { RedisTraceStore } from "../store/trace-store.js";
import { resolveLLMRuntime } from "./llm-runtime.js";
import { withRetry } from "../utils/retry.js";

const llmRequestTimeoutMs = 90_000;

export class SectionAgentTeamValidationError extends Error {
  constructor(
    message: string,
    readonly normalizedContent: string,
    readonly errors: string[],
    readonly repairGuidance = ""
  ) {
    super(message);
    this.name = "SectionAgentTeamValidationError";
  }
}

function maxRepairFallbackRounds(section: string): number {
  return section === "bullets" ? 3 : 2;
}

function safeSnippet(input: string, max = 600): string {
  const s = input.trim();
  if (!s) {
    return "";
  }
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}...<truncated>`;
}

function outputToText(output: unknown): string {
  if (typeof output === "string") {
    return output.trim();
  }
  if (output == null) {
    return "";
  }
  return String(output).trim();
}

function buildFailedCandidatePayload(section: string, normalizedContent: string): Record<string, unknown> {
  if (section === "bullets") {
    const lines = normalizedContent
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((line) => safeSnippet(line, 220));
    return lines.length > 0 ? { candidate_lines: lines } : {};
  }
  if (section === "description") {
    const paragraphs = normalizedContent
      .split(/\n\s*\n/g)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((paragraph) => safeSnippet(paragraph, 320));
    return paragraphs.length > 0 ? { candidate_paragraphs: paragraphs } : {};
  }
  return {};
}

function isAbortLikeError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes("abort");
}

function buildRetryUserPrompt(basePrompt: string, errors: string[], repairGuidance?: string): string {
  const normalizedErrors = errors
    .map((error) => error.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((error) => `- ${error}`);
  const normalizedGuidance = typeof repairGuidance === "string" ? repairGuidance.trim() : "";
  if (normalizedErrors.length === 0 && !normalizedGuidance) {
    return basePrompt;
  }
  return [
    basePrompt,
    "",
    "上轮校验失败，必须先修复以下问题，再提交最终内容：",
    normalizedErrors.join("\n"),
    normalizedGuidance ? `\n优先执行这份修复指导：\n${normalizedGuidance}` : ""
  ].join("\n");
}

const lineLengthErrorPattern = /^第(\d+)条长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;
const textLengthErrorPattern = /^长度不满足约束:\s*(\d+)（规则区间 \[(\d+),(\d+)\]，容差区间 \[(\d+),(\d+)\]）$/;

function countVisibleChars(input: string): number {
  return input.replace(/\*\*/g, "").length;
}

function buildOutputCharMetrics(input: string): { output_chars: number; raw_output_chars: number } {
  return {
    output_chars: countVisibleChars(input),
    raw_output_chars: input.length
  };
}

function buildRepairEditBrief(currentContent: string, errors: string[]): string {
  const lines = [
    "这是定量编辑任务，不是整条重写。",
    "修复目标：尽量保留现有语义主干、关键词顺序和已通过结构，只修被指出的问题。",
    `当前可见长度 ${countVisibleChars(currentContent)}。`
  ];
  for (const error of errors.slice(0, 6)) {
    const normalized = error.replace(/\s+/g, " ").trim();
    const lineMatched = lineLengthErrorPattern.exec(normalized);
    if (lineMatched) {
      const [, lineNo, actual, , , tolMin, tolMax] = lineMatched;
      if (Number.parseInt(actual, 10) < Number.parseInt(tolMin, 10)) {
        lines.push(`第${lineNo}条当前 ${actual}，目标至少 ${tolMin}，可接受上限 ${tolMax}；本轮优先补足差额，不要只换同义词。`);
      } else {
        lines.push(`第${lineNo}条当前 ${actual}，目标压回 ${tolMin}-${tolMax}；本轮优先删冗余，不要改掉核心语义。`);
      }
      continue;
    }
    const textMatched = textLengthErrorPattern.exec(normalized);
    if (textMatched) {
      const [, actual, , , tolMin, tolMax] = textMatched;
      if (Number.parseInt(actual, 10) < Number.parseInt(tolMin, 10)) {
        lines.push(`当前整体长度 ${actual}，目标至少 ${tolMin}，可接受上限 ${tolMax}；本轮只补必要信息。`);
      } else {
        lines.push(`当前整体长度 ${actual}，目标压回 ${tolMin}-${tolMax}；本轮只删多余信息。`);
      }
      continue;
    }
    if (normalized.includes("关键词顺序埋入不满足")) {
      lines.push("关键词顺序错误时，优先在原句里调整或腾位，不要重写整段。");
      continue;
    }
  }
  return lines.join("\n");
}

function buildRepairUserPrompt(
  basePrompt: string,
  currentContent: string,
  errors: string[],
  repairGuidance?: string,
  candidateLabel?: string
): string {
  return [
    candidateLabel ? `${candidateLabel}` : "",
    basePrompt,
    "",
    "编辑要求:",
    buildRepairEditBrief(currentContent, errors),
    "",
    "当前候选内容:",
    currentContent.trim(),
    "",
    "这份候选内容尚未通过校验，必须先修复以下问题，再输出最终内容：",
    errors
      .map((error) => error.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((error) => `- ${error}`)
      .join("\n"),
    repairGuidance ? `\n优先执行这份修复指导：\n${repairGuidance.trim()}` : ""
  ].join("\n");
}

function buildRepairFallbackInstructions(baseInstructions: string): string {
  return [
    baseInstructions,
    "当前是程序触发的修复兜底路径。",
    "repair_guidance 和 errors 的约束优先级最高，尤其先解决长度、缺失项和顺序错误。",
    "如果长度超限，先压回目标区间再润色；如果长度不足，先补足具体信息再润色。",
    "不要调用任何工具，不要尝试 handoff。",
    "必须直接重写并输出最终内容。",
    "只输出修复后的最终内容，不要解释。"
  ].join("\n");
}

function scoreRepairValidation(normalizedContent: string, errors: string[]): number {
  if (errors.length === 0) {
    return 0;
  }
  let penalty = errors.length * 10_000;
  for (const error of errors.slice(0, 8)) {
    const normalized = error.replace(/\s+/g, " ").trim();
    const lineMatched = lineLengthErrorPattern.exec(normalized);
    if (lineMatched) {
      const actual = Number.parseInt(lineMatched[2] ?? "0", 10);
      const tolMin = Number.parseInt(lineMatched[5] ?? "0", 10);
      const tolMax = Number.parseInt(lineMatched[6] ?? "0", 10);
      penalty += actual < tolMin ? tolMin - actual : Math.max(0, actual - tolMax);
      continue;
    }
    const textMatched = textLengthErrorPattern.exec(normalized);
    if (textMatched) {
      const actual = Number.parseInt(textMatched[1] ?? "0", 10);
      const tolMin = Number.parseInt(textMatched[4] ?? "0", 10);
      const tolMax = Number.parseInt(textMatched[5] ?? "0", 10);
      penalty += actual < tolMin ? tolMin - actual : Math.max(0, actual - tolMax);
      continue;
    }
    if (normalized.includes("关键词顺序埋入不满足")) {
      penalty += 5_000;
      continue;
    }
    penalty += 1_000;
  }
  penalty += Math.max(0, countVisibleChars(normalizedContent) / 1000);
  return penalty;
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): { signal?: AbortSignal; cleanup: () => void } {
  const activeSignals = signals.filter(Boolean) as AbortSignal[];
  if (activeSignals.length === 0) {
    return { cleanup: () => {} };
  }
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], cleanup: () => {} };
  }
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abortWith = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortWith(signal);
      return { signal: controller.signal, cleanup: () => {} };
    }
    const listener = () => abortWith(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  };
}

export class LLMClient {
  private readonly generationRunner: Runner;
  private readonly generationRequestURL: string;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
    private readonly traceStore?: RedisTraceStore,
    private readonly traceContext?: { tenantId: string; jobId: string },
    private readonly abortSignal?: AbortSignal
  ) {
    const generationRuntime = resolveLLMRuntime(env);
    const generationModelProvider = new OpenAIProvider({
      apiKey: env.deepseekApiKey,
      baseURL: generationRuntime.baseURL,
      useResponses: false
    });

    this.generationRunner = new Runner({
      modelProvider: generationModelProvider,
      tracingDisabled: true
    });

    this.generationRequestURL = generationRuntime.requestURL;
  }

  private async appendTrace(
    event: string,
    level: "info" | "warn" | "error" = "info",
    payload?: Record<string, unknown>
  ): Promise<void> {
    if (!this.traceStore || !this.traceContext) {
      return;
    }
    try {
      await this.traceStore.append({
        ts: new Date().toISOString(),
        source: "llm",
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

  private async runAgentText(runner: Runner, agent: Agent, input: string): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExternalAbort = () => {
      controller.abort(this.abortSignal?.reason ?? new Error("job cancelled"));
    };
    if (this.abortSignal) {
      if (this.abortSignal.aborted) {
        controller.abort(this.abortSignal.reason ?? new Error("job cancelled"));
      } else {
        this.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`agent request timeout after ${llmRequestTimeoutMs}ms`));
      }, llmRequestTimeoutMs);
    });
    const runPromise = runner.run(agent, input, { maxTurns: 2, signal: controller.signal }).then((result) => {
      const text = outputToText(result.finalOutput);
      if (!text) {
        throw new Error("agent output empty");
      }
      return text;
    });
    try {
      return await Promise.race([runPromise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (this.abortSignal) {
        this.abortSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  private buildAgentName(role: string, step: string): string {
    const normalizedRole = role.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "agent";
    const normalizedStep = step.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "step";
    return `${normalizedRole}_${normalizedStep}`;
  }

  private createSectionAgentTeamLifecycleTracer(
    section: string,
    step: string,
    team: SectionAgentTeam
  ): { cleanup: () => void; flush: () => Promise<void> } {
    const roleEntries = [
      ["planner", team.plannerAgent],
      ["writer", team.writerAgent],
      ["reviewer", team.reviewerAgent],
      ["repairer", team.repairerAgent]
    ].filter((entry): entry is [string, Agent] => Boolean(entry[1]));
    const pending = new Set<Promise<void>>();
    const currentTurnByAgent = new Map<string, number>();
    const listeners: Array<{ agent: Agent; event: string; listener: (...args: any[]) => void }> = [];
    let nextTurnIndex = 0;

    const enqueue = (task: Promise<void>) => {
      pending.add(task);
      void task.finally(() => {
        pending.delete(task);
      });
    };

    const write = (
      event: string,
      message: string,
      payload: Record<string, unknown>
    ) => enqueue((async () => {
      await this.appendTrace(event, "info", payload);
      this.logger.info({ event, ...payload }, message);
    })());

    const addListener = (agent: Agent, event: string, listener: (...args: any[]) => void) => {
      agent.on(event as any, listener);
      listeners.push({ agent, event, listener });
    };

    for (const [role, agent] of roleEntries) {
      addListener(agent, "agent_start", (_context, _currentAgent, turnInput) => {
        const turnIndex = ++nextTurnIndex;
        currentTurnByAgent.set(agent.name, turnIndex);
        write("agent_team_turn_start", "agent team turn start", {
          section,
          step,
          turn_index: turnIndex,
          agent_name: agent.name,
          agent_role: role,
          input_items: Array.isArray(turnInput) ? turnInput.length : 0
        });
      });

      addListener(agent, "agent_end", (_context, output) => {
        write("agent_team_turn_end", "agent team turn end", {
          section,
          step,
          turn_index: currentTurnByAgent.get(agent.name) ?? nextTurnIndex,
          agent_name: agent.name,
          agent_role: role,
          ...buildOutputCharMetrics(outputToText(output))
        });
      });

      addListener(agent, "agent_handoff", (_context, nextAgent) => {
        write("agent_team_handoff", "agent team handoff", {
          section,
          step,
          turn_index: currentTurnByAgent.get(agent.name) ?? nextTurnIndex,
          from_agent: agent.name,
          from_role: role,
          to_agent: nextAgent.name,
          to_role: roleEntries.find((entry) => entry[1].name === nextAgent.name)?.[0] ?? "unknown"
        });
      });

      addListener(agent, "agent_tool_start", (_context, toolDef, details) => {
        const toolCall = details?.toolCall as { id?: string; callId?: string; name?: string } | undefined;
        write("agent_team_tool_start", "agent team tool start", {
          section,
          step,
          turn_index: currentTurnByAgent.get(agent.name) ?? nextTurnIndex,
          agent_name: agent.name,
          agent_role: role,
          tool_name: toolDef.name,
          tool_call_id: toolCall?.callId ?? toolCall?.id ?? "",
          tool_call_name: toolCall?.name ?? toolDef.name
        });
      });

      addListener(agent, "agent_tool_end", (_context, toolDef, result, details) => {
        const toolCall = details?.toolCall as { id?: string; callId?: string; name?: string } | undefined;
        write("agent_team_tool_end", "agent team tool end", {
          section,
          step,
          turn_index: currentTurnByAgent.get(agent.name) ?? nextTurnIndex,
          agent_name: agent.name,
          agent_role: role,
          tool_name: toolDef.name,
          tool_call_id: toolCall?.callId ?? toolCall?.id ?? "",
          tool_call_name: toolCall?.name ?? toolDef.name,
          result_chars: outputToText(result).length
        });
      });
    }

    return {
      cleanup: () => {
        for (const { agent, event, listener } of listeners) {
          agent.off(event as any, listener);
        }
      },
      flush: async () => {
        while (pending.size > 0) {
          await Promise.all([...pending]);
        }
      }
    };
  }

  private resolveGenerationRuntime(
    runtimeProfile?: ModelProfile,
    modelSettingsOverride?: Partial<ModelSettings>
  ): {
    generationProvider: "deepseek";
    runner: Runner;
    model: string;
    requestURL: string;
    modelSettings: ModelSettings;
  } {
    const runtime = resolveLLMRuntime(this.env, runtimeProfile, modelSettingsOverride);
    return {
      generationProvider: "deepseek",
      runner: this.generationRunner,
      model: runtime.model,
      requestURL: runtime.requestURL || this.generationRequestURL,
      modelSettings: runtime.modelSettings
    };
  }

  async generateText(
    system: string,
    user: string,
    step: string,
    attempts: number,
    role: "planner" | "writer" | "repair" | "judge" = "writer",
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    const generationProvider = "deepseek";
    return withRetry(
      async (attempt) => {
        const { runner, model, requestURL, modelSettings } = this.resolveGenerationRuntime(undefined, modelSettingsOverride);

        await this.appendTrace("api_request", "info", {
          provider: generationProvider,
          step,
          attempt,
          url: requestURL
        });
        this.logger.info(
          {
            event: "api_request",
            provider: generationProvider,
            step,
            attempt,
            url: requestURL
          },
          "api request"
        );

        const started = Date.now();
        try {
          const agent = new Agent({
            name: this.buildAgentName(role, step),
            instructions: system,
            model,
            modelSettings
          });
          const text = await this.runAgentText(runner, agent, user);
          const latencyMs = Date.now() - started;

          await this.appendTrace("api_ok", "info", {
            provider: generationProvider,
            step,
            attempt,
            url: requestURL,
            status_code: 200,
            latency_ms: latencyMs,
            ...buildOutputCharMetrics(text)
          });
          this.logger.info(
            {
              event: "api_ok",
              provider: generationProvider,
              step,
              attempt,
              url: requestURL,
              status_code: 200,
              latency_ms: latencyMs,
              ...buildOutputCharMetrics(text)
            },
            "api ok"
          );
          return text;
        } catch (error) {
          const latencyMs = Date.now() - started;
          const message = error instanceof Error ? error.message : String(error);
          await this.appendTrace("api_failed", "error", {
            provider: generationProvider,
            step,
            attempt,
            url: requestURL,
            latency_ms: latencyMs,
            error_body: safeSnippet(message)
          });
          this.logger.error(
            {
              event: "api_failed",
              provider: generationProvider,
              step,
              attempt,
              url: requestURL,
              latency_ms: latencyMs,
              error_body: safeSnippet(message)
            },
            "api failed"
          );
          throw error;
        }
      },
      {
        attempts,
        baseMs: this.env.retryBaseMs,
        maxMs: this.env.retryMaxMs,
        jitter: this.env.retryJitter,
        shouldRetry: (_attempt, error) => !isAbortLikeError(error),
        onRetry: (attempt, error, waitMs) => {
          void this.appendTrace("api_retry", "warn", {
            provider: generationProvider,
            step,
            attempt,
            wait_ms: waitMs,
            error: error.message
          });
          this.logger.warn(
            { event: "api_retry", provider: generationProvider, step, attempt, wait_ms: waitMs, error: error.message },
            "api retry"
          );
        }
      }
    );
  }

  async generateSectionWithAgentTeam(input: {
    section: string;
    step: string;
    userPrompt: string;
    writerInstructions: string;
    reviewerInstructions?: string;
    repairInstructions?: string;
    attempts: number;
    maxTurns?: number;
    plannerRuntimeProfile?: ModelProfile;
    runtimeProfile?: ModelProfile;
    reviewerRuntimeProfile?: ModelProfile;
    repairerRuntimeProfile?: ModelProfile;
    modelSettingsOverride?: Partial<ModelSettings>;
    reviewerModelSettingsOverride?: Partial<ModelSettings>;
    repairerModelSettingsOverride?: Partial<ModelSettings>;
    shouldRetry?: (attempt: number, error: Error) => boolean;
    signal?: AbortSignal;
    validateContent: (content: string) => {
      ok: boolean;
      normalizedContent: string;
      finalOutput?: string;
      errors: string[];
      repairGuidance?: string;
    };
  }): Promise<string> {
    const sectionValidationToolName = "check_section_candidate";
    let retryValidationErrors: string[] = [];
    let retryRepairGuidance = "";
    const writerRuntime = this.resolveGenerationRuntime(input.runtimeProfile, input.modelSettingsOverride);
    const plannerRuntime = input.plannerRuntimeProfile
      ? this.resolveGenerationRuntime(input.plannerRuntimeProfile)
      : writerRuntime;
    const reviewerRuntime = input.reviewerRuntimeProfile
      ? this.resolveGenerationRuntime(input.reviewerRuntimeProfile, input.reviewerModelSettingsOverride)
      : undefined;
    const repairerRuntime = input.repairerRuntimeProfile
      ? this.resolveGenerationRuntime(input.repairerRuntimeProfile, input.repairerModelSettingsOverride)
      : undefined;
    const {
      generationProvider,
      runner,
      model,
      requestURL,
      modelSettings
    } = writerRuntime;
    return withRetry(
      async (attempt) => {
        let failedCandidatePayload: Record<string, unknown> = {};
        await this.appendTrace("agent_team_request", "info", {
          provider: generationProvider,
          section: input.section,
          step: input.step,
          attempt,
          url: requestURL
        });
        const started = Date.now();
        const validateCandidate = tool({
          name: sectionValidationToolName,
          description: "校验当前 section 草稿并返回规范化结果与错误列表。",
          parameters: z.object({
            content: z.string()
          }),
          execute: async ({ content }) => {
            const validation = input.validateContent(content);
            return JSON.stringify({
              ok: validation.ok,
              normalized_content: validation.normalizedContent,
              final_output: validation.finalOutput ?? validation.normalizedContent,
              errors: validation.errors,
              repair_guidance: validation.repairGuidance ?? ""
            });
          }
        });

        const team = buildSectionAgentTeam({
          section: input.section,
          step: input.step,
          validateToolName: sectionValidationToolName,
          plannerRuntime: {
            model: plannerRuntime.model,
            modelSettings: plannerRuntime.modelSettings
          },
          writerRuntime: {
            model,
            modelSettings
          },
          reviewerRuntime: reviewerRuntime
            ? {
                model: reviewerRuntime.model,
                modelSettings: reviewerRuntime.modelSettings
              }
            : undefined,
          repairerRuntime: repairerRuntime
            ? {
                model: repairerRuntime.model,
                modelSettings: repairerRuntime.modelSettings
              }
            : undefined,
          validateTool: validateCandidate,
          writerInstructions: input.writerInstructions,
          reviewerInstructions: input.reviewerInstructions,
          repairInstructions: input.repairInstructions
        });

        const session = new MemorySession();
        const lifecycleTrace = this.createSectionAgentTeamLifecycleTracer(input.section, input.step, team);
        const linkedAbort = linkAbortSignals(this.abortSignal, input.signal);
        try {
          const prompt = retryValidationErrors.length > 0
            ? buildRetryUserPrompt(input.userPrompt, retryValidationErrors, retryRepairGuidance)
            : input.userPrompt;
          const entryAgent = input.reviewerInstructions ? team.plannerAgent : team.writerAgent;
          const runAgent = async (agent: Agent, agentPrompt: string): Promise<string> => {
            const result = await runner.run(agent, agentPrompt, {
              maxTurns: input.maxTurns ?? 8,
              session: new MemorySession(),
              signal: linkedAbort.signal
            });
            return outputToText(result.finalOutput);
          };
          let text = await runAgent(entryAgent, prompt);
          if (!text) {
            throw new Error("section agent team output empty");
          }
          let validation = input.validateContent(text);
          if (!validation.ok && team.repairerAgent) {
            const repairFallbackAgent = new Agent({
              name: team.repairerAgent.name,
              instructions: buildRepairFallbackInstructions(input.repairInstructions ?? input.writerInstructions),
              model: repairerRuntime?.model ?? writerRuntime.model,
              modelSettings: repairerRuntime?.modelSettings ?? writerRuntime.modelSettings
            });
            for (let repairRound = 1; repairRound <= maxRepairFallbackRounds(input.section) && !validation.ok; repairRound += 1) {
              await this.appendTrace("agent_team_repair_fallback_start", "warn", {
                provider: generationProvider,
                section: input.section,
                step: input.step,
                attempt,
                repair_round: repairRound,
                error_count: validation.errors.length,
                errors: validation.errors.slice(0, 6),
                ...buildOutputCharMetrics(validation.normalizedContent || text)
              });
              const repairPrompt = buildRepairUserPrompt(
                input.userPrompt,
                validation.normalizedContent || text,
                validation.errors,
                validation.repairGuidance
              );
              const candidateRuns = await Promise.allSettled(
                [1, 2].map(async (candidateIndex) => {
                  const repairedText = await runAgent(
                    repairFallbackAgent,
                    buildRepairUserPrompt(
                      input.userPrompt,
                      validation.normalizedContent || text,
                      validation.errors,
                      validation.repairGuidance,
                      candidateIndex === 1
                        ? "修复候选#1：优先最小改动，先保留原句结构。"
                        : "修复候选#2：允许更积极地补足或压缩长度，但不要改变语义主干。"
                    )
                  );
                  if (!repairedText) {
                    throw new Error("section agent team repair output empty");
                  }
                  const candidateValidation = input.validateContent(repairedText);
                  return {
                    candidateIndex,
                    repairedText,
                    validation: candidateValidation,
                    score: scoreRepairValidation(candidateValidation.normalizedContent, candidateValidation.errors)
                  };
                })
              );
              const successfulCandidates = candidateRuns
                .filter((result): result is PromiseFulfilledResult<{
                  candidateIndex: number;
                  repairedText: string;
                  validation: ReturnType<typeof input.validateContent>;
                  score: number;
                }> => result.status === "fulfilled")
                .map((result) => result.value)
                .sort((left, right) => left.score - right.score || left.candidateIndex - right.candidateIndex);
              if (successfulCandidates.length === 0) {
                throw new Error("section agent team repair output empty");
              }
              const chosen = successfulCandidates[0];
              text = chosen.repairedText;
              validation = chosen.validation;
              await this.appendTrace(
                validation.ok ? "agent_team_repair_fallback_ok" : "agent_team_repair_fallback_failed",
                validation.ok ? "info" : "warn",
                {
                  provider: generationProvider,
                  section: input.section,
                  step: input.step,
                  attempt,
                  repair_round: repairRound,
                  repair_candidate_count: successfulCandidates.length,
                  repair_candidates: successfulCandidates.map((candidate) => ({
                    candidate_index: candidate.candidateIndex,
                    score: candidate.score,
                    error_count: candidate.validation.errors.length,
                    selected: candidate.candidateIndex === chosen.candidateIndex
                  })),
                  error_count: validation.errors.length,
                  errors: validation.errors.slice(0, 6),
                  ...buildOutputCharMetrics(validation.normalizedContent)
                }
              );
            }
          }
          if (!validation.ok) {
            retryValidationErrors = validation.errors;
            retryRepairGuidance = validation.repairGuidance ?? "";
            failedCandidatePayload = buildFailedCandidatePayload(input.section, validation.normalizedContent);
            throw new SectionAgentTeamValidationError(
              `section agent team validation failed: ${validation.errors.join("; ")}`,
              validation.normalizedContent,
              validation.errors,
              validation.repairGuidance ?? ""
            );
          }
          await lifecycleTrace.flush();
          retryValidationErrors = [];
          retryRepairGuidance = "";
          await this.appendTrace("agent_team_ok", "info", {
            provider: generationProvider,
            section: input.section,
            step: input.step,
            attempt,
            url: requestURL,
            latency_ms: Date.now() - started,
            ...buildOutputCharMetrics(validation.normalizedContent)
          });
          return validation.normalizedContent;
        } catch (error) {
          await lifecycleTrace.flush();
          const message = error instanceof Error ? error.message : String(error);
          const failurePayload = {
            provider: generationProvider,
            section: input.section,
            step: input.step,
            attempt,
            url: requestURL,
            latency_ms: Date.now() - started,
            error_body: safeSnippet(message),
            ...failedCandidatePayload
          };
          await this.appendTrace("agent_team_candidate_failed", "warn", failurePayload);
          this.logger.warn(
            { event: "agent_team_candidate_failed", ...failurePayload },
            "agent team candidate failed"
          );
          throw error;
        } finally {
          linkedAbort.cleanup();
          lifecycleTrace.cleanup();
        }
      },
      {
        attempts: input.attempts,
        baseMs: this.env.retryBaseMs,
        maxMs: this.env.retryMaxMs,
        jitter: this.env.retryJitter,
        shouldRetry: (attempt, error) =>
          !isAbortLikeError(error) &&
          (input.shouldRetry ? input.shouldRetry(attempt, error) : true)
      }
    );
  }

  async translateText(
    system: string,
    user: string,
    step: string,
    attempts: number,
    runtimeProfile?: ModelProfile
  ): Promise<string> {
    const { generationProvider, runner, model, requestURL, modelSettings } = this.resolveGenerationRuntime(runtimeProfile);
    return withRetry(
      async (attempt) => {
        await this.appendTrace("api_request", "info", {
          provider: generationProvider,
          step,
          attempt,
          url: requestURL
        });
        this.logger.info(
          {
            event: "api_request",
            provider: generationProvider,
            step,
            attempt,
            url: requestURL
          },
          "api request"
        );
        const started = Date.now();

        try {
          const agent = new Agent({
            name: this.buildAgentName("translator", step),
            instructions: system,
            model,
            modelSettings
          });
          const text = await this.runAgentText(runner, agent, user);
          const latencyMs = Date.now() - started;
          await this.appendTrace("api_ok", "info", {
            provider: generationProvider,
            step,
            attempt,
            url: requestURL,
            status_code: 200,
            latency_ms: latencyMs,
            ...buildOutputCharMetrics(text)
          });
          this.logger.info(
            {
              event: "api_ok",
              provider: generationProvider,
              step,
              attempt,
              url: requestURL,
              status_code: 200,
              latency_ms: latencyMs,
              ...buildOutputCharMetrics(text)
            },
            "api ok"
          );
          return text;
        } catch (error) {
          const latencyMs = Date.now() - started;
          const message = error instanceof Error ? error.message : String(error);
          await this.appendTrace("api_failed", "error", {
            provider: generationProvider,
            step,
            attempt,
            url: requestURL,
            latency_ms: latencyMs,
            error_body: safeSnippet(message)
          });
          this.logger.error(
            {
              event: "api_failed",
              provider: generationProvider,
              step,
              attempt,
              url: requestURL,
              latency_ms: latencyMs,
              error_body: safeSnippet(message)
            },
            "api failed"
          );
          throw error;
        }
      },
      {
        attempts,
        baseMs: this.env.retryBaseMs,
        maxMs: this.env.retryMaxMs,
        jitter: this.env.retryJitter,
        shouldRetry: (_attempt, error) => !isAbortLikeError(error),
        onRetry: (attempt, error, waitMs) => {
          void this.appendTrace("api_retry", "warn", {
            provider: generationProvider,
            step,
            attempt,
            wait_ms: waitMs,
            error: error.message
          });
          this.logger.warn(
            { event: "api_retry", provider: generationProvider, step, attempt, wait_ms: waitMs, error: error.message },
            "api retry"
          );
        }
      }
    );
  }

  async planWithPlannerAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateText(system, user, step, attempts, "planner", modelSettingsOverride);
  }

  async runtimePlanWithPlannerAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateText(system, user, step, attempts, "planner", modelSettingsOverride);
  }

  async writeWithWriterAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateText(system, user, step, attempts, "writer", modelSettingsOverride);
  }

  async repairWithRepairAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateText(system, user, step, attempts, "repair", modelSettingsOverride);
  }

  async reviewWithJudgeAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateText(system, user, step, attempts, "judge", modelSettingsOverride);
  }

  async translateWithTranslatorAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    runtimeProfile?: ModelProfile
  ): Promise<string> {
    return this.translateText(system, user, step, attempts, runtimeProfile);
  }
}
