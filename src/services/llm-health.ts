import type { Logger } from "pino";
import type { AppEnv } from "../config/env.js";
import { withRetry } from "../utils/retry.js";

export interface ProviderHealth {
  ok: boolean;
  checked_at: string;
  required?: boolean;
  error?: string;
}

export interface LLMHealthReport {
  ok: boolean;
  checked_at: string;
  cached: boolean;
  llm: {
    fluxcode: ProviderHealth;
    deepseek: ProviderHealth;
  };
}

function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function readBodySafe(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.slice(0, 800);
  } catch {
    return "";
  }
}

export class LLMHealthService {
  private cachedReport: LLMHealthReport | null = null;

  private cacheExpireAtMs = 0;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger
  ) {}

  async check(force = false): Promise<LLMHealthReport> {
    const now = Date.now();
    if (!force && this.cachedReport && now < this.cacheExpireAtMs) {
      return { ...this.cachedReport, cached: true };
    }

    const [fluxcode, deepseek] = await Promise.all([this.checkFluxcode(), this.checkDeepseek()]);
    const report: LLMHealthReport = {
      ok: fluxcode.ok && deepseek.ok,
      checked_at: new Date().toISOString(),
      cached: false,
      llm: {
        fluxcode,
        deepseek
      }
    };

    this.cachedReport = report;
    this.cacheExpireAtMs = now + this.env.healthcheckLlmCacheSeconds * 1000;
    return report;
  }

  private async checkFluxcode(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const required = this.env.generationProvider === "fluxcode";
    if (!this.env.fluxcodeApiKey) {
      if (!required) {
        return {
          ok: true,
          checked_at: checkedAt,
          required: false,
          error: "not_required"
        };
      }
      return {
        ok: false,
        checked_at: checkedAt,
        required: true,
        error: "FLUXCODE_API_KEY 未配置"
      };
    }
    const url = joinUrl(this.env.fluxcodeBaseUrl, this.env.fluxcodeResponsesPath);

    try {
      await withRetry(
        async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.env.fluxcodeApiKey}`
            },
            signal: AbortSignal.timeout(this.env.healthcheckLlmTimeoutSeconds * 1000),
            body: JSON.stringify({
              model: this.env.fluxcodeModel,
              reasoning: { effort: "low" },
              temperature: 0,
              max_output_tokens: 1,
              input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }]
            })
          });

          if (!response.ok) {
            const body = await readBodySafe(response);
            throw new Error(`status=${response.status} body=${body}`);
          }
        },
        {
          attempts: this.env.healthcheckLlmRetries,
          baseMs: this.env.retryBaseMs,
          maxMs: this.env.retryMaxMs,
          jitter: this.env.retryJitter
        }
      );
      return { ok: true, checked_at: checkedAt, required };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ event: "health_fluxcode_invalid", error: message }, "fluxcode key check failed");
      return { ok: false, checked_at: checkedAt, required, error: message };
    }
  }

  private async checkDeepseek(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const url = joinUrl(this.env.deepseekBaseUrl, this.env.deepseekChatPath);

    try {
      await withRetry(
        async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.env.deepseekApiKey}`
            },
            signal: AbortSignal.timeout(this.env.healthcheckLlmTimeoutSeconds * 1000),
            body: JSON.stringify({
              model: this.env.deepseekModel,
              temperature: 0,
              max_tokens: 1,
              stream: false,
              messages: [{ role: "user", content: "ping" }]
            })
          });

          if (!response.ok) {
            const body = await readBodySafe(response);
            throw new Error(`status=${response.status} body=${body}`);
          }
        },
        {
          attempts: this.env.healthcheckLlmRetries,
          baseMs: this.env.retryBaseMs,
          maxMs: this.env.retryMaxMs,
          jitter: this.env.retryJitter
        }
      );
      return { ok: true, checked_at: checkedAt, required: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ event: "health_deepseek_invalid", error: message }, "deepseek key check failed");
      return { ok: false, checked_at: checkedAt, required: true, error: message };
    }
  }
}
