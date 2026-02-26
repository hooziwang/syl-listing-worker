import type { Redis } from "ioredis";

const TRACE_KEY_PREFIX = "syl:trace:job:";
const TRACE_START_KEY_PREFIX = "syl:trace:job-start:";

export interface JobTraceEvent {
  ts: string;
  source: "api" | "runner" | "generation" | "llm";
  event: string;
  level?: "info" | "warn" | "error";
  tenant_id: string;
  job_id: string;
  elapsed_ms?: number;
  req_id?: string;
  payload?: Record<string, unknown>;
}

function traceKey(jobId: string): string {
  return `${TRACE_KEY_PREFIX}${jobId}`;
}

function traceStartKey(jobId: string): string {
  return `${TRACE_START_KEY_PREFIX}${jobId}`;
}

export class RedisTraceStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number
  ) {}

  private async resolveStartMs(jobId: string): Promise<number> {
    const key = traceStartKey(jobId);
    const now = Date.now();
    const setResult = await this.redis.set(key, String(now), "EX", this.ttlSeconds, "NX");
    if (setResult === "OK") {
      return now;
    }

    const raw = await this.redis.get(key);
    const parsed = Number.parseInt(raw || "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    await this.redis.set(key, String(now), "EX", this.ttlSeconds);
    return now;
  }

  async append(evt: JobTraceEvent): Promise<void> {
    if (!evt.job_id) {
      return;
    }
    const key = traceKey(evt.job_id);
    const startMs = await this.resolveStartMs(evt.job_id);
    const now = Date.now();
    const enriched: JobTraceEvent = {
      ...evt,
      elapsed_ms: Math.max(0, now - startMs)
    };
    await this.redis.rpush(key, JSON.stringify(enriched));
    await this.redis.expire(key, this.ttlSeconds);
    await this.redis.expire(traceStartKey(evt.job_id), this.ttlSeconds);
  }

  async list(jobId: string, limit: number, offset: number): Promise<JobTraceEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 5000));
    const safeOffset = Math.max(0, offset);
    const start = safeOffset;
    const end = safeOffset + safeLimit - 1;
    const raw = await this.redis.lrange(traceKey(jobId), start, end);
    const out: JobTraceEvent[] = [];
    for (const item of raw) {
      try {
        out.push(JSON.parse(item) as JobTraceEvent);
      } catch {
        // ignore broken line
      }
    }
    return out;
  }

  async count(jobId: string): Promise<number> {
    return this.redis.llen(traceKey(jobId));
  }
}
