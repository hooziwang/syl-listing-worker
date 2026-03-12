import type { Redis } from "ioredis";
import type { JobStatus } from "../domain/types.js";
import type { JobTraceEvent } from "./trace-store.js";

const JOB_EVENT_CHANNEL_PREFIX = "syl:job:event:";

export interface TraceJobEventMessage {
  type: "trace";
  job_id: string;
  tenant_id: string;
  offset: number;
  item: JobTraceEvent;
}

export interface StatusJobEventMessage {
  type: "status";
  job_id: string;
  tenant_id: string;
  status: JobStatus;
  updated_at: string;
  error?: string;
}

export type JobEventMessage = TraceJobEventMessage | StatusJobEventMessage;

export interface JobEventSubscriber {
  subscribe(jobId: string, onEvent: (event: JobEventMessage) => void): Promise<void>;
  close(): Promise<void>;
}

function channelFor(jobId: string): string {
  return `${JOB_EVENT_CHANNEL_PREFIX}${jobId}`;
}

function parseJobEventMessage(raw: string): JobEventMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<JobEventMessage> & { type?: string };
    if (parsed.type === "trace") {
      if (
        typeof parsed.job_id === "string" &&
        typeof parsed.tenant_id === "string" &&
        typeof parsed.offset === "number" &&
        parsed.item &&
        typeof parsed.item === "object"
      ) {
        return parsed as TraceJobEventMessage;
      }
      return null;
    }
    if (parsed.type === "status") {
      if (
        typeof parsed.job_id === "string" &&
        typeof parsed.tenant_id === "string" &&
        typeof parsed.status === "string" &&
        typeof parsed.updated_at === "string"
      ) {
        return parsed as StatusJobEventMessage;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

class RedisPubSubJobEventSubscriber implements JobEventSubscriber {
  private readonly redis: Redis;
  private readonly messageHandler: (channel: string, message: string) => void;
  private subscribedChannel = "";

  constructor(redis: Redis) {
    this.redis = redis;
    this.messageHandler = (channel, message) => {
      if (!this.subscribedChannel || channel !== this.subscribedChannel) {
        return;
      }
      const parsed = parseJobEventMessage(message);
      if (parsed) {
        this.onEvent?.(parsed);
      }
    };
    this.redis.on("message", this.messageHandler);
  }

  private onEvent?: (event: JobEventMessage) => void;

  async subscribe(jobId: string, onEvent: (event: JobEventMessage) => void): Promise<void> {
    this.onEvent = onEvent;
    this.subscribedChannel = channelFor(jobId);
    await this.redis.subscribe(this.subscribedChannel);
  }

  async close(): Promise<void> {
    if (this.subscribedChannel) {
      try {
        await this.redis.unsubscribe(this.subscribedChannel);
      } catch {
        // ignore unsubscribe failure during shutdown
      }
    }
    this.redis.off("message", this.messageHandler);
    await this.redis.quit();
  }
}

export class RedisJobEventBus {
  constructor(private readonly redis: Redis) {}

  async publishTrace(jobId: string, tenantId: string, offset: number, item: JobTraceEvent): Promise<void> {
    const payload: TraceJobEventMessage = {
      type: "trace",
      job_id: jobId,
      tenant_id: tenantId,
      offset,
      item
    };
    await this.redis.publish(channelFor(jobId), JSON.stringify(payload));
  }

  async publishStatus(
    jobId: string,
    tenantId: string,
    status: JobStatus,
    updatedAt: string,
    error?: string
  ): Promise<void> {
    const payload: StatusJobEventMessage = {
      type: "status",
      job_id: jobId,
      tenant_id: tenantId,
      status,
      updated_at: updatedAt,
      error: error || undefined
    };
    await this.redis.publish(channelFor(jobId), JSON.stringify(payload));
  }

  createSubscriber(): JobEventSubscriber {
    return new RedisPubSubJobEventSubscriber(this.redis.duplicate());
  }
}
