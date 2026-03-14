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
          tenant_id: "syl"
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
          syl: "rules-syl-current"
        };
      },
      async resolve() {
        return {
          up_to_date: false,
          rules_version: "rules-syl-v1",
          manifest_sha256: "a".repeat(64),
          download_url: "",
          signature_base64: "sig",
          signature_algo: "rsa-sha256",
          signing_public_key_path_in_archive: "tenant/rules_signing_public.pem",
          signing_public_key_signature_base64: "pubsig",
          signing_public_key_signature_algo: "rsa-sha256"
        };
      }
    },
    versionService: {
      async read() {
        return {
          service: "syl-listing-worker",
          worker_version: "v0.1.0",
          git_commit: "abc1234",
          build_time: "2026-03-11T04:00:00Z",
          deployed_at: "2026-03-11T04:05:00Z"
        };
      }
    },
    jobStore: {},
    traceStore: {},
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

test("GET /v1/rules/resolve 只使用转发头里的第一个 proto 和 host 生成 download_url", async (t) => {
  const app = await buildApiServer(createContext());
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/v1/rules/resolve",
    headers: {
      authorization: "Bearer token",
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "files.example.com, proxy.internal"
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.json().download_url,
    "https://files.example.com/v1/rules/download/syl/rules-syl-v1"
  );
});

test("POST /v1/rules/refresh 会忽略多值转发头里的后续代理值", async (t) => {
  const app = await buildApiServer(createContext());
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "POST",
    url: "/v1/rules/refresh",
    headers: {
      authorization: "Bearer token",
      "x-forwarded-proto": " https , http ",
      "x-forwarded-host": " files.example.com:8443 , proxy.internal "
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.json().download_url,
    "https://files.example.com:8443/v1/rules/download/syl/rules-syl-v1"
  );
});
