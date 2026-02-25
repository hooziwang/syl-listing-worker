import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Redis } from "ioredis";
import type { RulesResolveResponse } from "../domain/types.js";

const CURRENT_KEY_PREFIX = "syl:rules:current:";
const META_KEY_PREFIX = "syl:rules:meta:";

export interface PublishRulesInput {
  tenant_id: string;
  rules_version: string;
  manifest_sha256: string;
  archive_base64: string;
  signature_base64?: string;
  signature_algo?: string;
}

interface RulesMeta {
  manifest_sha256: string;
  signature_base64?: string;
  signature_algo?: string;
}

export class RulesService {
  constructor(
    private readonly redis: Redis,
    private readonly rulesFsDir: string,
    private readonly apiPublicBaseUrl: string
  ) {}

  private currentKey(tenantId: string): string {
    return `${CURRENT_KEY_PREFIX}${tenantId}`;
  }

  private metaKey(tenantId: string, rulesVersion: string): string {
    return `${META_KEY_PREFIX}${tenantId}:${rulesVersion}`;
  }

  private archivePath(tenantId: string, rulesVersion: string): string {
    return join(this.rulesFsDir, tenantId, rulesVersion, "rules.tar.gz");
  }

  async bootstrap(input: {
    tenant_id: string;
    rules_version: string;
    manifest_sha256: string;
    signature_base64?: string;
    signature_algo?: string;
  }): Promise<void> {
    const current = await this.redis.get(this.currentKey(input.tenant_id));
    if (current) {
      return;
    }

    const key = this.metaKey(input.tenant_id, input.rules_version);
    await this.redis.hset(key, {
      manifest_sha256: input.manifest_sha256,
      signature_base64: input.signature_base64 || "",
      signature_algo: input.signature_algo || "ed25519"
    });
    await this.redis.set(this.currentKey(input.tenant_id), input.rules_version);
  }

  async resolve(tenantId: string, currentVersion: string | undefined): Promise<RulesResolveResponse> {
    const activeVersion = await this.redis.get(this.currentKey(tenantId));
    if (!activeVersion) {
      throw new Error(`tenant(${tenantId}) 未发布规则`);
    }
    const metaHash = await this.redis.hgetall(this.metaKey(tenantId, activeVersion));
    const meta: RulesMeta = {
      manifest_sha256: metaHash.manifest_sha256 || "",
      signature_base64: metaHash.signature_base64 || undefined,
      signature_algo: metaHash.signature_algo || undefined
    };

    return {
      up_to_date: currentVersion === activeVersion,
      rules_version: activeVersion,
      manifest_sha256: meta.manifest_sha256,
      download_url: `${this.apiPublicBaseUrl}/v1/rules/download/${encodeURIComponent(tenantId)}/${encodeURIComponent(activeVersion)}`,
      signature_base64: meta.signature_base64,
      signature_algo: meta.signature_algo
    };
  }

  async publish(input: PublishRulesInput): Promise<void> {
    const raw = Buffer.from(input.archive_base64, "base64");
    const got = createHash("sha256").update(raw).digest("hex");
    if (got !== input.manifest_sha256) {
      throw new Error(`manifest sha256 mismatch: got=${got} want=${input.manifest_sha256}`);
    }

    const archivePath = this.archivePath(input.tenant_id, input.rules_version);
    await mkdir(join(this.rulesFsDir, input.tenant_id, input.rules_version), { recursive: true });
    await writeFile(archivePath, raw);

    const key = this.metaKey(input.tenant_id, input.rules_version);
    await this.redis.hset(key, {
      manifest_sha256: input.manifest_sha256,
      signature_base64: input.signature_base64 || "",
      signature_algo: input.signature_algo || "ed25519"
    });
    await this.redis.set(this.currentKey(input.tenant_id), input.rules_version);
  }

  async rollback(tenantId: string, rulesVersion: string): Promise<void> {
    const meta = await this.redis.hgetall(this.metaKey(tenantId, rulesVersion));
    if (!meta || !meta.manifest_sha256) {
      throw new Error("rules version not found");
    }
    await this.redis.set(this.currentKey(tenantId), rulesVersion);
  }

  async readArchive(tenantId: string, rulesVersion: string): Promise<Buffer> {
    return readFile(this.archivePath(tenantId, rulesVersion));
  }
}
