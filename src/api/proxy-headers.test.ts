import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApiServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const httpTemplatePath = resolve(here, "../../docker/nginx/templates/http.conf.template");
const httpsTemplatePath = resolve(here, "../../docker/nginx/templates/https.conf.template");

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
      async resolve() {
        return {
          up_to_date: false,
          rules_version: "rules-syl-current",
          manifest_sha256: "manifest-sha",
          download_url: "http://placeholder.invalid/v1/rules/download/syl/rules-syl-current",
          signature_base64: "sig",
          signature_algo: "rsa-sha256",
          signing_public_key_path_in_archive: "tenant/rules_signing_public.pem",
          signing_public_key_signature_base64: "pub-sig",
          signing_public_key_signature_algo: "rsa-sha256"
        };
      }
    },
    versionService: {
      async read() {
        return {
          service: "syl-listing-worker",
          worker_version: "v0.1.2",
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

test("nginx HTTP 模板会透传原始 host 头与端口", async () => {
  const template = await readFile(httpTemplatePath, "utf8");

  assert.match(template, /proxy_set_header Host \$http_host;/);
  assert.match(template, /proxy_set_header X-Forwarded-Host \$http_host;/);
});

test("nginx HTTPS 模板会透传原始 host 头与端口", async () => {
  const template = await readFile(httpsTemplatePath, "utf8");

  assert.match(template, /proxy_set_header Host \$http_host;/);
  assert.match(template, /proxy_set_header X-Forwarded-Host \$http_host;/);
});

test("GET /v1/rules/resolve 会在 download_url 中保留代理转发的端口", async (t) => {
  const app = await buildApiServer(createContext());
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/v1/rules/resolve?current=",
    headers: {
      authorization: "Bearer token",
      host: "127.0.0.1",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "127.0.0.1:18080"
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-tenant-id"], "syl");
  assert.equal(
    res.json().download_url,
    "http://127.0.0.1:18080/v1/rules/download/syl/rules-syl-current"
  );
});

test("POST /v1/rules/refresh 会在 download_url 中保留代理转发的端口", async (t) => {
  const app = await buildApiServer(createContext());
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "POST",
    url: "/v1/rules/refresh",
    headers: {
      authorization: "Bearer token",
      host: "127.0.0.1",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "127.0.0.1:18080"
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-tenant-id"], "syl");
  assert.equal(
    res.json().download_url,
    "http://127.0.0.1:18080/v1/rules/download/syl/rules-syl-current"
  );
});
