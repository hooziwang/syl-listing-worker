import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(calls.filter((entry) => entry === "markStatus:job-1:running").length, 2);
});
