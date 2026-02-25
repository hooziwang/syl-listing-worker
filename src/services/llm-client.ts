import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import { withRetry } from "../utils/retry.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
    private readonly logger: Logger
  ) {}

  async generateWithFluxcode(system: string, user: string, step: string, attempts: number): Promise<string> {
    const url = joinUrl(this.env.fluxcodeBaseUrl, this.env.fluxcodeResponsesPath);

    return withRetry(
      async (attempt) => {
        this.logger.info({ event: "api_request", provider: "fluxcode", step, attempt, url }, "api request");

        const response = await fetch(url, {
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

        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          throw new Error(`fluxcode ${response.status}: ${JSON.stringify(payload)}`);
        }

        const text = parseResponsesText(payload);
        this.logger.info({ event: "api_ok", provider: "fluxcode", step, attempt }, "api ok");
        return text;
      },
      {
        attempts,
        baseMs: this.env.retryBaseMs,
        maxMs: this.env.retryMaxMs,
        jitter: this.env.retryJitter,
        onRetry: (attempt, error, waitMs) => {
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
        this.logger.info({ event: "api_request", provider: "deepseek", step, attempt, url }, "api request");

        const response = await fetch(url, {
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

        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          throw new Error(`deepseek ${response.status}: ${JSON.stringify(payload)}`);
        }

        const text = parseDeepseekText(payload);
        this.logger.info({ event: "api_ok", provider: "deepseek", step, attempt }, "api ok");
        return text;
      },
      {
        attempts,
        baseMs: this.env.retryBaseMs,
        maxMs: this.env.retryMaxMs,
        jitter: this.env.retryJitter,
        onRetry: (attempt, error, waitMs) => {
          this.logger.warn(
            { event: "api_retry", provider: "deepseek", step, attempt, wait_ms: waitMs, error: error.message },
            "api retry"
          );
        }
      }
    );
  }
}
