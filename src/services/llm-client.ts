import { Agent, OpenAIProvider, Runner, type ModelSettings } from "@openai/agents";
import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { RedisTraceStore } from "../store/trace-store.js";
import { withRetry } from "../utils/retry.js";

const llmRequestTimeoutMs = 90_000;

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

function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    return "";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/g, "");
}

function resolveProviderBaseURL(baseUrl: string, endpointPath: string, endpointSuffix: string): string {
  const base = baseUrl.replace(/\/+$/g, "");
  const endpoint = normalizePath(endpointPath);
  const suffix = normalizePath(endpointSuffix);

  if (!endpoint || endpoint === suffix) {
    return base;
  }
  if (!endpoint.endsWith(suffix)) {
    return base;
  }

  const prefix = endpoint.slice(0, endpoint.length - suffix.length);
  if (!prefix || prefix === "/") {
    return base;
  }
  return `${base}${prefix}`;
}

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

function asReasoningEffort(v: string): ReasoningEffort | undefined {
  const value = v.trim().toLowerCase();
  if (value === "") {
    return undefined;
  }
  switch (value) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
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

export class LLMClient {
  private readonly fluxRunner?: Runner;
  private readonly deepseekRunner: Runner;
  private readonly fluxRequestURL: string;
  private readonly deepseekRequestURL: string;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
    private readonly traceStore?: RedisTraceStore,
    private readonly traceContext?: { tenantId: string; jobId: string }
  ) {
    const fluxBaseURL = resolveProviderBaseURL(env.fluxcodeBaseUrl, env.fluxcodeResponsesPath, "/responses");
    const deepseekBaseURL = resolveProviderBaseURL(env.deepseekBaseUrl, env.deepseekChatPath, "/chat/completions");

    if (env.fluxcodeApiKey) {
      const fluxProvider = new OpenAIProvider({
        apiKey: env.fluxcodeApiKey,
        baseURL: fluxBaseURL,
        useResponses: true
      });
      this.fluxRunner = new Runner({
        modelProvider: fluxProvider,
        tracingDisabled: true
      });
    }
    const deepseekProvider = new OpenAIProvider({
      apiKey: env.deepseekApiKey,
      baseURL: deepseekBaseURL,
      useResponses: false
    });

    this.deepseekRunner = new Runner({
      modelProvider: deepseekProvider,
      tracingDisabled: true
    });

    this.fluxRequestURL = joinUrl(env.fluxcodeBaseUrl, env.fluxcodeResponsesPath);
    this.deepseekRequestURL = joinUrl(env.deepseekBaseUrl, env.deepseekChatPath);
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
    }
  }

  private buildAgentName(role: string, step: string): string {
    const normalizedRole = role.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "agent";
    const normalizedStep = step.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "step";
    return `${normalizedRole}_${normalizedStep}`;
  }

  private getGenerationProvider(): "fluxcode" | "deepseek" {
    return this.env.generationProvider;
  }

  async generateWithFluxcode(
    system: string,
    user: string,
    step: string,
    attempts: number,
    role: "planner" | "orchestrator" | "writer" | "repair" | "judge" = "writer",
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    const generationProvider = this.getGenerationProvider();
    return withRetry(
      async (attempt) => {
        const useFlux = generationProvider === "fluxcode";
        const runner = useFlux ? this.fluxRunner : this.deepseekRunner;
        const model = useFlux ? this.env.fluxcodeModel : this.env.deepseekModel;
        const requestURL = useFlux ? this.fluxRequestURL : this.deepseekRequestURL;
        if (!runner) {
          throw new Error("FLUXCODE_API_KEY 未配置，无法使用 fluxcode 生成");
        }

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
        const baseModelSettings: ModelSettings =
          generationProvider === "fluxcode"
            ? { temperature: this.env.fluxcodeTemperature }
            : { temperature: this.env.deepseekTemperature };
        if (generationProvider === "fluxcode") {
          const effort = asReasoningEffort(this.env.fluxcodeReasoningEffort);
          if (effort) {
            baseModelSettings.reasoning = { effort };
          }
        }
        let modelSettings: ModelSettings = baseModelSettings;
        if (modelSettingsOverride) {
          modelSettings = {
            ...baseModelSettings,
            ...modelSettingsOverride
          };
          if (baseModelSettings.providerData || modelSettingsOverride.providerData) {
            modelSettings.providerData = {
              ...(baseModelSettings.providerData ?? {}),
              ...(modelSettingsOverride.providerData ?? {})
            };
          }
        }

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
            output_chars: text.length
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
              output_chars: text.length
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

  async translateWithDeepseek(system: string, user: string, step: string, attempts: number): Promise<string> {
    return withRetry(
      async (attempt) => {
        await this.appendTrace("api_request", "info", {
          provider: "deepseek",
          step,
          attempt,
          url: this.deepseekRequestURL
        });
        this.logger.info(
          {
            event: "api_request",
            provider: "deepseek",
            step,
            attempt,
            url: this.deepseekRequestURL
          },
          "api request"
        );
        const started = Date.now();

        const modelSettings: ModelSettings = {
          temperature: this.env.deepseekTemperature
        };

        try {
          const agent = new Agent({
            name: this.buildAgentName("translator", step),
            instructions: system,
            model: this.env.deepseekModel,
            modelSettings
          });
          const text = await this.runAgentText(this.deepseekRunner, agent, user);
          const latencyMs = Date.now() - started;
          await this.appendTrace("api_ok", "info", {
            provider: "deepseek",
            step,
            attempt,
            url: this.deepseekRequestURL,
            status_code: 200,
            latency_ms: latencyMs,
            output_chars: text.length
          });
          this.logger.info(
            {
              event: "api_ok",
              provider: "deepseek",
              step,
              attempt,
              url: this.deepseekRequestURL,
              status_code: 200,
              latency_ms: latencyMs,
              output_chars: text.length
            },
            "api ok"
          );
          return text;
        } catch (error) {
          const latencyMs = Date.now() - started;
          const message = error instanceof Error ? error.message : String(error);
          await this.appendTrace("api_failed", "error", {
            provider: "deepseek",
            step,
            attempt,
            url: this.deepseekRequestURL,
            latency_ms: latencyMs,
            error_body: safeSnippet(message)
          });
          this.logger.error(
            {
              event: "api_failed",
              provider: "deepseek",
              step,
              attempt,
              url: this.deepseekRequestURL,
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
        onRetry: (attempt, error, waitMs) => {
          void this.appendTrace("api_retry", "warn", {
            provider: "deepseek",
            step,
            attempt,
            wait_ms: waitMs,
            error: error.message
          });
          this.logger.warn(
            { event: "api_retry", provider: "deepseek", step, attempt, wait_ms: waitMs, error: error.message },
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
    return this.generateWithFluxcode(system, user, step, attempts, "planner", modelSettingsOverride);
  }

  async orchestrateWithOrchestratorAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateWithFluxcode(system, user, step, attempts, "orchestrator", modelSettingsOverride);
  }

  async writeWithWriterAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateWithFluxcode(system, user, step, attempts, "writer", modelSettingsOverride);
  }

  async repairWithRepairAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateWithFluxcode(system, user, step, attempts, "repair", modelSettingsOverride);
  }

  async reviewWithJudgeAgent(
    system: string,
    user: string,
    step: string,
    attempts: number,
    modelSettingsOverride?: Partial<ModelSettings>
  ): Promise<string> {
    return this.generateWithFluxcode(system, user, step, attempts, "judge", modelSettingsOverride);
  }

  async translateWithTranslatorAgent(system: string, user: string, step: string, attempts: number): Promise<string> {
    return this.translateWithDeepseek(system, user, step, attempts);
  }
}
