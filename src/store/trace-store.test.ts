import test from "node:test";
import assert from "node:assert/strict";
import { RedisJobEventBus } from "./job-events.js";
import { RedisTraceStore } from "./trace-store.js";

type TraceSource = "api" | "runner" | "generation" | "llm";

class FakePipeline {
  private readonly ops: Array<{ type: "rpush" | "expire"; run: () => Promise<unknown> }> = [];

  constructor(private readonly redis: FakeRedis) {}

  rpush(key: string, value: string): this {
    this.ops.push({ type: "rpush", run: () => this.redis.rpush(key, value) });
    return this;
  }

  expire(key: string, ttlSeconds: number): this {
    this.ops.push({ type: "expire", run: () => this.redis.expire(key, ttlSeconds) });
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    this.redis.pipelineExecCount += 1;
    const results: Array<[Error | null, unknown]> = [];
    for (const op of this.ops) {
      if (op.type === "rpush" && this.redis.pipelineRpushError) {
        results.push([this.redis.pipelineRpushError, null]);
        continue;
      }
      results.push([null, await op.run()]);
    }
    return results;
  }
}

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();
  readonly setCalls: string[] = [];
  readonly getCalls: string[] = [];
  readonly expireCalls: Array<{ key: string; ttlSeconds: number }> = [];
  readonly rpushCalls: Array<{ key: string; value: string }> = [];
  readonly publishCalls: Array<{ channel: string; message: string }> = [];
  pipelineExecCount = 0;
  delayNextSet: Promise<void> | null = null;
  pipelineRpushError: Error | null = null;

  async set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    this.setCalls.push(key);
    const delay = this.delayNextSet;
    if (delay) {
      this.delayNextSet = null;
      await delay;
    }
    const useNx = args.includes("NX");
    if (useNx && this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return this.values.get(key) ?? null;
  }

  async rpush(key: string, value: string): Promise<number> {
    this.rpushCalls.push({ key, value });
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    this.expireCalls.push({ key, ttlSeconds });
    return 1;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.publishCalls.push({ channel, message });
    return 1;
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }
}

function buildEvent(jobId: string, source: TraceSource = "runner") {
  return {
    ts: new Date(0).toISOString(),
    source,
    event: "trace_event",
    tenant_id: "tenant-1",
    job_id: jobId
  } as const;
}

test("同一任务连续 append 只解析一次 startMs", async () => {
  const redis = new FakeRedis();
  const store = new RedisTraceStore(redis as never, 60);
  const originalNow = Date.now;
  let now = 1_000;

  Date.now = () => now;
  try {
    await store.append(buildEvent("job-1"));
    now = 1_550;
    await store.append(buildEvent("job-1"));
  } finally {
    Date.now = originalNow;
  }

  assert.equal(redis.setCalls.length, 1);
  assert.equal(redis.getCalls.length, 0);
  assert.equal(redis.pipelineExecCount, 2);

  const rows = redis.lists.get("syl:trace:job:job-1");
  assert.ok(rows);
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[0]!).elapsed_ms, 0);
  assert.equal(JSON.parse(rows[1]!).elapsed_ms, 550);
});

test("同一任务并发 append 共享同一个 startMs 解析过程", async () => {
  const redis = new FakeRedis();
  const store = new RedisTraceStore(redis as never, 60);
  let releaseSet: (() => void) | undefined;
  redis.delayNextSet = new Promise<void>((resolve) => {
    releaseSet = resolve;
  });

  const first = store.append(buildEvent("job-2", "generation"));
  await Promise.resolve();
  const second = store.append(buildEvent("job-2", "llm"));
  await Promise.resolve();

  assert.equal(redis.setCalls.length, 1);

  releaseSet?.();
  await Promise.all([first, second]);

  assert.equal(redis.setCalls.length, 1);
  assert.equal(redis.getCalls.length, 0);
  assert.equal(redis.pipelineExecCount, 2);

  const rows = redis.lists.get("syl:trace:job:job-2");
  assert.ok(rows);
  assert.equal(rows.length, 2);
});

test("append 会透传 pipeline 内部的 Redis 错误", async () => {
  const redis = new FakeRedis();
  redis.pipelineRpushError = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
  const store = new RedisTraceStore(redis as never, 60);

  await assert.rejects(
    () => store.append(buildEvent("job-3")),
    /WRONGTYPE Operation against a key holding the wrong kind of value/
  );
});

test("append 会发布实时 trace 事件，供 SSE 订阅使用", async () => {
  const redis = new FakeRedis();
  const store = new RedisTraceStore(redis as never, 60, new RedisJobEventBus(redis as never));

  await store.append(buildEvent("job-live", "generation"));

  assert.equal(redis.publishCalls.length, 1);
  assert.equal(redis.publishCalls[0]?.channel, "syl:job:event:job-live");

  const payload = JSON.parse(redis.publishCalls[0]!.message) as {
    type: string;
    offset: number;
    item: {
      job_id: string;
      source: string;
      event: string;
    };
  };
  assert.equal(payload.type, "trace");
  assert.equal(payload.offset, 1);
  assert.equal(payload.item.job_id, "job-live");
  assert.equal(payload.item.source, "generation");
  assert.equal(payload.item.event, "trace_event");
});
