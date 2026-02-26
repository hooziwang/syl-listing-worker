import type { Redis } from "ioredis";

const TRACE_KEY_PREFIX = "syl:trace:job:";

export interface JobTraceEvent {
  ts: string;
  source: "api" | "runner" | "generation" | "llm";
  event: string;
  level?: "info" | "warn" | "error";
  tenant_id: string;
  job_id: string;
  req_id?: string;
  payload?: Record<string, unknown>;
}

function traceKey(jobId: string): string {
  return `${TRACE_KEY_PREFIX}${jobId}`;
}

export class RedisTraceStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number
  ) {}

  async append(evt: JobTraceEvent): Promise<void> {
    if (!evt.job_id) {
      return;
    }
    const key = traceKey(evt.job_id);
    await this.redis.rpush(key, JSON.stringify(evt));
    await this.redis.expire(key, this.ttlSeconds);
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
