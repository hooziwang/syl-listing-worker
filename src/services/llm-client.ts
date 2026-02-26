import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import type { RedisTraceStore } from "../store/trace-store.js";
import { withRetry } from "../utils/retry.js";

const llmRequestTimeoutMs = 90_000;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

function parseJSONSafe(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw_text: safeSnippet(text) };
  }
}

function pickHeader(response: Response, names: string[]): string {
  for (const name of names) {
    const value = response.headers.get(name);
    if (value) {
      return value;
    }
  }
  return "";
}

function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function parseDeepseekText(payload: unknown): string {
  const obj = payload as { choices?: Array<{ message?: { content?: string } }> };
  const text = obj.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("deepseek response content missing");
  }
  return text.trim();
}

function parseResponsesText(payload: unknown): string {
  const obj = payload as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };

  if (typeof obj.output_text === "string" && obj.output_text.trim()) {
    return obj.output_text.trim();
  }

  const parts: string[] = [];
  for (const m of obj.output ?? []) {
    for (const c of m.content ?? []) {
      if (typeof c.text === "string" && c.text.trim()) {
        parts.push(c.text.trim());
      }
    }
  }

  if (parts.length === 0) {
    throw new Error("responses output text missing");
  }
  return parts.join("\n").trim();
}

export class LLMClient {
  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger,
    private readonly traceStore?: RedisTraceStore,
    private readonly traceContext?: { tenantId: string; jobId: string }
  ) {}

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

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), llmRequestTimeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateWithFluxcode(system: string, user: string, step: string, attempts: number): Promise<string> {
    const url = joinUrl(this.env.fluxcodeBaseUrl, this.env.fluxcodeResponsesPath);

    return withRetry(
      async (attempt) => {
        await this.appendTrace("api_request", "info", { provider: "fluxcode", step, attempt, url });
        this.logger.info({ event: "api_request", provider: "fluxcode", step, attempt, url }, "api request");
        const started = Date.now();

        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.env.fluxcodeApiKey}`
          },
          body: JSON.stringify({
            model: this.env.fluxcodeModel,
            reasoning: { effort: this.env.fluxcodeReasoningEffort },
            temperature: this.env.fluxcodeTemperature,
            input: [
              { role: "system", content: [{ type: "input_text", text: system }] },
              { role: "user", content: [{ type: "input_text", text: user }] }
            ]
          })
        });

        const bodyText = await response.text();
        const payload = parseJSONSafe(bodyText);
        const latencyMs = Date.now() - started;
        const providerReqID = pickHeader(response, ["x-request-id", "request-id", "openai-request-id"]);
        if (!response.ok) {
          await this.appendTrace("api_failed", "error", {
            provider: "fluxcode",
            step,
            attempt,
            url,
            status_code: response.status,
            latency_ms: latencyMs,
            response_id: providerReqID,
            error_body: safeSnippet(bodyText)
          });
          this.logger.error(
            {
              event: "api_failed",
              provider: "fluxcode",
              step,
              attempt,
              url,
              status_code: response.status,
              latency_ms: latencyMs,
              response_id: providerReqID,
              error_body: safeSnippet(bodyText)
            },
            "api failed"
          );
          throw new Error(`fluxcode ${response.status}: ${JSON.stringify(payload)}`);
        }

        const text = parseResponsesText(payload);
        await this.appendTrace("api_ok", "info", {
          provider: "fluxcode",
          step,
          attempt,
          url,
          status_code: response.status,
          latency_ms: latencyMs,
          response_id: providerReqID,
          output_chars: text.length
        });
        this.logger.info(
          {
            event: "api_ok",
            provider: "fluxcode",
            step,
            attempt,
            url,
            status_code: response.status,
            latency_ms: latencyMs,
            response_id: providerReqID,
            output_chars: text.length
          },
          "api ok"
        );
        return text;
      },
      {
        attempts,
        baseMs: this.env.retryBaseMs,
        maxMs: this.env.retryMaxMs,
        jitter: this.env.retryJitter,
        onRetry: (attempt, error, waitMs) => {
          void this.appendTrace("api_retry", "warn", {
            provider: "fluxcode",
            step,
            attempt,
            wait_ms: waitMs,
            error: error.message
          });
          this.logger.warn(
            { event: "api_retry", provider: "fluxcode", step, attempt, wait_ms: waitMs, error: error.message },
            "api retry"
          );
        }
      }
    );
  }

  async translateWithDeepseek(system: string, user: string, step: string, attempts: number): Promise<string> {
    const url = joinUrl(this.env.deepseekBaseUrl, this.env.deepseekChatPath);

    return withRetry(
      async (attempt) => {
        await this.appendTrace("api_request", "info", { provider: "deepseek", step, attempt, url });
        this.logger.info({ event: "api_request", provider: "deepseek", step, attempt, url }, "api request");
        const started = Date.now();

        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.env.deepseekApiKey}`
          },
          body: JSON.stringify({
            model: this.env.deepseekModel,
            temperature: this.env.deepseekTemperature,
            stream: false,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user }
            ] as ChatMessage[]
          })
        });

        const bodyText = await response.text();
        const payload = parseJSONSafe(bodyText);
        const latencyMs = Date.now() - started;
        const providerReqID = pickHeader(response, ["x-request-id", "request-id"]);
        if (!response.ok) {
          await this.appendTrace("api_failed", "error", {
            provider: "deepseek",
            step,
            attempt,
            url,
            status_code: response.status,
            latency_ms: latencyMs,
            response_id: providerReqID,
            error_body: safeSnippet(bodyText)
          });
          this.logger.error(
            {
              event: "api_failed",
              provider: "deepseek",
              step,
              attempt,
              url,
              status_code: response.status,
              latency_ms: latencyMs,
              response_id: providerReqID,
              error_body: safeSnippet(bodyText)
            },
            "api failed"
          );
          throw new Error(`deepseek ${response.status}: ${JSON.stringify(payload)}`);
        }

        const text = parseDeepseekText(payload);
        await this.appendTrace("api_ok", "info", {
          provider: "deepseek",
          step,
          attempt,
          url,
          status_code: response.status,
          latency_ms: latencyMs,
          response_id: providerReqID,
          output_chars: text.length
        });
        this.logger.info(
          {
            event: "api_ok",
            provider: "deepseek",
            step,
            attempt,
            url,
            status_code: response.status,
            latency_ms: latencyMs,
            response_id: providerReqID,
            output_chars: text.length
          },
          "api ok"
        );
        return text;
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
}
