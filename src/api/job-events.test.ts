import test from "node:test";
import assert from "node:assert/strict";
import { buildApiServer } from "./server.js";

function createContext() {
  return {
    env: {
      logLevel: "silent",
      adminToken: "admin-secret"
    },
    authService: {
      verifyBearerToken() {
        return {
          tenant_id: "demo"
        };
      }
    },
    llmHealthService: {
      async check() {
        return { ok: true, llm: { deepseek: { ok: true } } };
      }
    },
    rulesService: {
      async listCurrentVersions() {
        return {
          demo: "rules-demo-current"
        };
      }
    },
    versionService: {
      async read() {
        return {
          service: "syl-listing-worker",
          git_commit: "abc1234",
          build_time: "2026-03-11T04:00:00Z",
          deployed_at: "2026-03-11T04:05:00Z"
        };
      }
    },
    jobStore: {
      async get() {
        return {
          id: "job-1",
          tenant_id: "demo",
          status: "running",
          created_at: "2026-03-12T00:00:00Z",
          updated_at: "2026-03-12T00:00:01Z"
        };
      }
    },
    traceStore: {
      async list() {
        return [];
      },
      async count() {
        return 0;
      }
    },
    jobEvents: {
      createSubscriber() {
        return {
          async subscribe() {},
          async close() {}
        };
      }
    },
    queue: {}
  } as any;
}

test("旧的 job 状态与 trace 接口已经移除", async (t) => {
  const app = await buildApiServer(createContext());
  t.after(async () => {
    await app.close();
  });

  const headers = {
    authorization: "Bearer token"
  };
  const statusRes = await app.inject({
    method: "GET",
    url: "/v1/jobs/job-1",
    headers
  });
  assert.equal(statusRes.statusCode, 404);

  const traceRes = await app.inject({
    method: "GET",
    url: "/v1/jobs/job-1/trace",
    headers
  });
  assert.equal(traceRes.statusCode, 404);
});
