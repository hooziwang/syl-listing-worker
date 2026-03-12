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
        throw new Error("not implemented");
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
          demo: "rules-demo-current",
          syl: "rules-syl-current"
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
    jobStore: {},
    traceStore: {},
    queue: {}
  } as any;
}

test("GET /v1/admin/version 未带 admin token 返回 401", async (t) => {
  const app = await buildApiServer(createContext());
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/v1/admin/version"
  });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), {
    error: "invalid_admin_token",
    tenant_id: "admin"
  });
});

test("GET /v1/admin/version 返回版本元数据", async (t) => {
  const app = await buildApiServer(createContext());
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/v1/admin/version",
    headers: {
      authorization: "Bearer admin-secret"
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-tenant-id"], "admin");
  assert.deepEqual(res.json(), {
    ok: true,
    tenant_id: "admin",
    service: "syl-listing-worker",
    git_commit: "abc1234",
    build_time: "2026-03-11T04:00:00Z",
    deployed_at: "2026-03-11T04:05:00Z",
    rules_versions: {
      demo: "rules-demo-current",
      syl: "rules-syl-current"
    }
  });
});
