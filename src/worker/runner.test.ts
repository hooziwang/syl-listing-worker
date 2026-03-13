import test from "node:test";
import assert from "node:assert/strict";
import { InputValidationError } from "../services/generation-service.js";
import { createJobProcessor } from "./runner.js";

function createLogger() {
  const logger = {
    child() {
      return logger;
    },
    info() {},
    warn() {},
    error() {}
  };
  return logger;
}

test("非最终重试不会清掉取消请求标记", async () => {
  const calls: string[] = [];
  const store = {
    async markStatus(jobId: string, status: string) {
      calls.push(`markStatus:${jobId}:${status}`);
    },
    async isCancelRequested() {
      return false;
    },
    async markCancelled(jobId: string, message: string) {
      calls.push(`markCancelled:${jobId}:${message}`);
    },
    async markSucceeded(jobId: string) {
      calls.push(`markSucceeded:${jobId}`);
    },
    async markFailed(jobId: string, message: string) {
      calls.push(`markFailed:${jobId}:${message}`);
    },
    async clearCancelRequest(jobId: string) {
      calls.push(`clearCancelRequest:${jobId}`);
    },
    async getRuntimeSections() {
      return {};
    },
    async saveRuntimeSection() {
      // noop
    }
  };
  const traceStore = {
    async append() {}
  };
  const rulesService = {
    async resolve() {
      return {
        rules_version: "rules-v1"
      };
    }
  };
  const processor = createJobProcessor(
    {
      queueName: "queue",
      workerConcurrency: 1
    } as never,
    store as never,
    traceStore as never,
    rulesService as never,
    createLogger() as never,
    () => ({
      async generate() {
        throw new Error("transient network error");
      }
    }) as never
  );

  await assert.rejects(
    () =>
      processor({
        id: "queue-job-1",
        attemptsMade: 0,
        opts: {
          attempts: 2
        },
        data: {
          job_id: "job-1",
          tenant_id: "tenant-1",
          input_markdown: "hello",
          input_filename: "input.md"
        }
      } as never),
    /transient network error/
  );

  assert.deepEqual(
    calls.filter((entry) => entry.startsWith("clearCancelRequest:")),
    []
  );
  assert.ok(calls.includes("markStatus:job-1:running"));
  assert.ok(calls.includes("markStatus:job-1:retrying"));
  assert.equal(calls.filter((entry) => entry === "markStatus:job-1:running").length, 1);
});

test("重试 attempt 会把已完成 section checkpoint 传回 generation service", async () => {
  const calls: string[] = [];
  let receivedInput: any;
  const store = {
    async markStatus(jobId: string, status: string) {
      calls.push(`markStatus:${jobId}:${status}`);
    },
    async isCancelRequested() {
      return false;
    },
    async markCancelled(jobId: string, message: string) {
      calls.push(`markCancelled:${jobId}:${message}`);
    },
    async markSucceeded(jobId: string) {
      calls.push(`markSucceeded:${jobId}`);
    },
    async markFailed(jobId: string, message: string) {
      calls.push(`markFailed:${jobId}:${message}`);
    },
    async getRuntimeSections(jobId: string) {
      calls.push(`getRuntimeSections:${jobId}`);
      return {
        title: "cached-title",
        description: "cached-description"
      };
    },
    async saveRuntimeSection(jobId: string, section: string, value: string) {
      calls.push(`saveRuntimeSection:${jobId}:${section}:${value}`);
    }
  };
  const traceStore = {
    async append() {}
  };
  const rulesService = {
    async resolve() {
      return {
        rules_version: "rules-v1"
      };
    }
  };
  const processor = createJobProcessor(
    {
      queueName: "queue",
      workerConcurrency: 1
    } as never,
    store as never,
    traceStore as never,
    rulesService as never,
    createLogger() as never,
    () => ({
      async generate(input: unknown) {
        receivedInput = input;
        const runtimeInput = input as {
          persistRuntimeSection?: (section: string, value: string) => Promise<void>;
        };
        await runtimeInput.persistRuntimeSection?.("bullets", "cached-bullets");
        throw new Error("transient network error");
      }
    }) as never
  );

  await assert.rejects(
    () =>
      processor({
        id: "queue-job-2",
        attemptsMade: 1,
        opts: {
          attempts: 3
        },
        data: {
          job_id: "job-2",
          tenant_id: "tenant-1",
          input_markdown: "hello",
          input_filename: "input.md"
        }
      } as never),
    /transient network error/
  );

  assert.deepEqual(receivedInput?.resumeSections, {
    title: "cached-title",
    description: "cached-description"
  });
  assert.equal(typeof receivedInput?.persistRuntimeSection, "function");
  assert.ok(calls.includes("getRuntimeSections:job-2"));
  assert.ok(calls.includes("saveRuntimeSection:job-2:bullets:cached-bullets"));
});

test("运行中的任务会通过 cancel pubsub 立即中断，不依赖轮询", async () => {
  const calls: string[] = [];
  let onCancelMessage: ((jobId: string) => void) | undefined;
  let generateAborted = false;
  let isCancelRequestedCalls = 0;
  const store = {
    async markStatus(jobId: string, status: string) {
      calls.push(`markStatus:${jobId}:${status}`);
    },
    async isCancelRequested() {
      isCancelRequestedCalls += 1;
      return false;
    },
    async markCancelled(jobId: string, message: string) {
      calls.push(`markCancelled:${jobId}:${message}`);
    },
    async markSucceeded(jobId: string) {
      calls.push(`markSucceeded:${jobId}`);
    },
    async markFailed(jobId: string, message: string) {
      calls.push(`markFailed:${jobId}:${message}`);
    },
    async getRuntimeSections() {
      return {};
    },
    async saveRuntimeSection() {
      // noop
    }
  };
  const traceStore = {
    async append() {}
  };
  const rulesService = {
    async resolve() {
      return {
        rules_version: "rules-v1"
      };
    }
  };
  const processor = createJobProcessor(
    {
      queueName: "queue",
      workerConcurrency: 1
    } as never,
    store as never,
    traceStore as never,
    rulesService as never,
    createLogger() as never,
    (_env, _logger, _traceStore, _context, abortSignal) => ({
      async generate() {
        await new Promise<void>((resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              generateAborted = true;
              reject(abortSignal.reason ?? new Error("aborted"));
            },
            { once: true }
          );
        });
      }
    }) as never,
    async (jobId, onMessage) => {
      calls.push(`subscribeCancel:${jobId}`);
      onCancelMessage = onMessage;
      return async () => {
        calls.push(`unsubscribeCancel:${jobId}`);
      };
    }
  );

  const running = processor({
    id: "queue-job-3",
    attemptsMade: 0,
    opts: {
      attempts: 1
    },
    data: {
      job_id: "job-3",
      tenant_id: "tenant-1",
      input_markdown: "hello",
      input_filename: "input.md"
    }
  } as never);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof onCancelMessage, "function");
  onCancelMessage?.("job-3");
  await running;

  assert.equal(generateAborted, true);
  assert.ok(calls.includes("subscribeCancel:job-3"));
  assert.ok(calls.includes("unsubscribeCancel:job-3"));
  assert.ok(calls.includes("markCancelled:job-3:任务被用户取消"));
  assert.equal(isCancelRequestedCalls, 2);
});

test("输入校验错误会直接失败，不进入重试", async () => {
  const calls: string[] = [];
  const store = {
    async markStatus(jobId: string, status: string) {
      calls.push(`markStatus:${jobId}:${status}`);
    },
    async isCancelRequested() {
      return false;
    },
    async markCancelled(jobId: string, message: string) {
      calls.push(`markCancelled:${jobId}:${message}`);
    },
    async markSucceeded(jobId: string) {
      calls.push(`markSucceeded:${jobId}`);
    },
    async markFailed(jobId: string, message: string) {
      calls.push(`markFailed:${jobId}:${message}`);
    },
    async getRuntimeSections() {
      return {};
    },
    async saveRuntimeSection() {
      // noop
    }
  };
  const traceStore = {
    async append() {}
  };
  const rulesService = {
    async resolve() {
      return {
        rules_version: "rules-v1"
      };
    }
  };
  const processor = createJobProcessor(
    {
      queueName: "queue",
      workerConcurrency: 1
    } as never,
    store as never,
    traceStore as never,
    rulesService as never,
    createLogger() as never,
    () => ({
      async generate() {
        throw new InputValidationError("输入文件未命中当前租户模板标记: ===Listing Requirements===");
      }
    }) as never
  );

  await processor({
    id: "queue-job-4",
    attemptsMade: 0,
    opts: {
      attempts: 3
    },
    data: {
      job_id: "job-4",
      tenant_id: "tenant-1",
      input_markdown: "hello",
      input_filename: "input.md"
    }
  } as never);

  assert.ok(calls.includes("markStatus:job-4:running"));
  assert.ok(calls.includes("markFailed:job-4:输入文件未命中当前租户模板标记: ===Listing Requirements==="));
  assert.equal(calls.some((entry) => entry === "markStatus:job-4:retrying"), false);
});
