import type { Redis } from "ioredis";
import type { JobRecord, JobStatus, ListingResult } from "../domain/types.js";
import type { RedisJobEventBus } from "./job-events.js";

const JOB_KEY_PREFIX = "syl:job:";
const JOB_CANCEL_KEY_PREFIX = "syl:job:cancel:";
export const JOB_CANCEL_CHANNEL = "syl:job:cancel:channel";

function jobKey(jobId: string): string {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

function cancelKey(jobId: string): string {
  return `${JOB_CANCEL_KEY_PREFIX}${jobId}`;
}

export class RedisJobStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly jobEvents?: RedisJobEventBus
  ) {}

  async createQueued(jobId: string, tenantId: string): Promise<JobRecord> {
    const now = new Date().toISOString();
    const key = jobKey(jobId);
    await this.redis.hset(key, {
      id: jobId,
      tenant_id: tenantId,
      status: "queued",
      created_at: now,
      updated_at: now
    });
    await this.redis.expire(key, this.ttlSeconds);
    if (this.jobEvents) {
      await this.jobEvents.publishStatus(jobId, tenantId, "queued", now);
    }
    return {
      id: jobId,
      tenant_id: tenantId,
      status: "queued",
      created_at: now,
      updated_at: now
    };
  }

  async markStatus(jobId: string, status: JobStatus): Promise<void> {
    const key = jobKey(jobId);
    const updatedAt = new Date().toISOString();
    await this.redis.hset(key, {
      status,
      updated_at: updatedAt
    });
    await this.redis.expire(key, this.ttlSeconds);
    if (!this.jobEvents) {
      return;
    }
    const record = await this.get(jobId);
    if (record) {
      await this.jobEvents.publishStatus(jobId, record.tenant_id, status, updatedAt, record.error_message);
    }
  }

  async markFailed(jobId: string, message: string): Promise<void> {
    const key = jobKey(jobId);
    const updatedAt = new Date().toISOString();
    await this.redis.hset(key, {
      status: "failed",
      error_message: message,
      updated_at: updatedAt
    });
    await this.redis.del(cancelKey(jobId));
    await this.redis.expire(key, this.ttlSeconds);
    if (!this.jobEvents) {
      return;
    }
    const record = await this.get(jobId);
    if (record) {
      await this.jobEvents.publishStatus(jobId, record.tenant_id, "failed", updatedAt, message);
    }
  }

  async markCancelled(jobId: string, message = "任务已取消"): Promise<void> {
    const key = jobKey(jobId);
    const updatedAt = new Date().toISOString();
    await this.redis.hset(key, {
      status: "cancelled",
      error_message: message,
      updated_at: updatedAt
    });
    await this.redis.del(cancelKey(jobId));
    await this.redis.expire(key, this.ttlSeconds);
    if (!this.jobEvents) {
      return;
    }
    const record = await this.get(jobId);
    if (record) {
      await this.jobEvents.publishStatus(jobId, record.tenant_id, "cancelled", updatedAt, message);
    }
  }

  async markSucceeded(jobId: string, result: ListingResult): Promise<void> {
    const key = jobKey(jobId);
    const updatedAt = new Date().toISOString();
    await this.redis.hset(key, {
      status: "succeeded",
      result_json: JSON.stringify(result),
      updated_at: updatedAt
    });
    await this.redis.del(cancelKey(jobId));
    await this.redis.expire(key, this.ttlSeconds);
    if (!this.jobEvents) {
      return;
    }
    const record = await this.get(jobId);
    if (record) {
      await this.jobEvents.publishStatus(jobId, record.tenant_id, "succeeded", updatedAt);
    }
  }

  async requestCancel(jobId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.redis.hset(jobKey(jobId), {
      cancel_requested_at: now,
      updated_at: now
    });
    await this.redis.set(cancelKey(jobId), "1", "EX", this.ttlSeconds);
    await this.redis.expire(jobKey(jobId), this.ttlSeconds);
  }

  async isCancelRequested(jobId: string): Promise<boolean> {
    const exists = await this.redis.exists(cancelKey(jobId));
    return exists > 0;
  }

  async publishCancel(jobId: string): Promise<void> {
    await this.redis.publish(JOB_CANCEL_CHANNEL, jobId);
  }

  async clearCancelRequest(jobId: string): Promise<void> {
    await this.redis.del(cancelKey(jobId));
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const key = jobKey(jobId);
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    const base: JobRecord = {
      id: data.id,
      tenant_id: data.tenant_id,
      status: (data.status as JobStatus) ?? "queued",
      created_at: data.created_at,
      updated_at: data.updated_at,
      cancel_requested_at: data.cancel_requested_at || undefined,
      error_message: data.error_message || undefined
    };

    if (data.result_json) {
      try {
        base.result = JSON.parse(data.result_json) as ListingResult;
      } catch {
        base.error_message = "result_json parse failed";
      }
    }

    return base;
  }

  async consumeResult(jobId: string): Promise<ListingResult | null> {
    const record = await this.get(jobId);
    if (!record || record.status !== "succeeded" || !record.result) {
      return null;
    }

    await this.redis.del(jobKey(jobId));
    return record.result;
  }
}
