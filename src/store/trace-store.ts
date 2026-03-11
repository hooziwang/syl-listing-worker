import type { Redis } from "ioredis";

const TRACE_KEY_PREFIX = "syl:trace:job:";
const TRACE_START_KEY_PREFIX = "syl:trace:job-start:";
const START_MS_CACHE_LIMIT = 1024;

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
  private readonly startMsCache = new Map<string, number>();
  private readonly startMsInflight = new Map<string, Promise<number>>();

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number
  ) {}

  private rememberStartMs(jobId: string, startMs: number): number {
    if (this.startMsCache.has(jobId)) {
      this.startMsCache.delete(jobId);
    }
    this.startMsCache.set(jobId, startMs);
    if (this.startMsCache.size > START_MS_CACHE_LIMIT) {
      const oldestJobId = this.startMsCache.keys().next().value;
      if (oldestJobId) {
        this.startMsCache.delete(oldestJobId);
      }
    }
    return startMs;
  }

  private readCachedStartMs(jobId: string): number | null {
    const cached = this.startMsCache.get(jobId);
    if (cached === undefined) {
      return null;
    }
    this.startMsCache.delete(jobId);
    this.startMsCache.set(jobId, cached);
    return cached;
  }

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

  private async getStartMs(jobId: string): Promise<number> {
    const cached = this.readCachedStartMs(jobId);
    if (cached !== null) {
      return cached;
    }

    const inflight = this.startMsInflight.get(jobId);
    if (inflight) {
      return inflight;
    }

    const started = this.resolveStartMs(jobId)
      .then((startMs) => this.rememberStartMs(jobId, startMs))
      .finally(() => {
        this.startMsInflight.delete(jobId);
      });
    this.startMsInflight.set(jobId, started);
    return started;
  }

  async append(evt: JobTraceEvent): Promise<void> {
    if (!evt.job_id) {
      return;
    }
    const key = traceKey(evt.job_id);
    const startKey = traceStartKey(evt.job_id);
    const startMs = await this.getStartMs(evt.job_id);
    const now = Date.now();
    const enriched: JobTraceEvent = {
      ...evt,
      elapsed_ms: Math.max(0, now - startMs)
    };
    const pipeline = this.redis.pipeline();
    pipeline.rpush(key, JSON.stringify(enriched));
    pipeline.expire(key, this.ttlSeconds);
    pipeline.expire(startKey, this.ttlSeconds);
    const results = await pipeline.exec();
    if (!results) {
      throw new Error("redis pipeline exec returned null");
    }
    for (const [error] of results) {
      if (error) {
        throw error;
      }
    }
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
