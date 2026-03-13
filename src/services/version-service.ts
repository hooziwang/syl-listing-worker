import { readFile } from "node:fs/promises";

export const DEFAULT_RUNTIME_VERSION_FILE = "/data/syl-listing/runtime/version.json";

export interface RuntimeVersionMetadata {
  service: string;
  worker_version: string;
  git_commit: string;
  build_time: string;
  deployed_at: string;
}

export class VersionService {
  constructor(private readonly versionFile = DEFAULT_RUNTIME_VERSION_FILE) {}

  async read(): Promise<RuntimeVersionMetadata> {
    let raw = "";
    try {
      raw = await readFile(this.versionFile, "utf8");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`读取版本文件失败: ${this.versionFile} (${msg})`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`解析版本文件失败: ${this.versionFile} (${msg})`);
    }

    const data = parsed as Partial<RuntimeVersionMetadata>;
    if (!data || typeof data !== "object") {
      throw new Error(`版本文件内容非法: ${this.versionFile}`);
    }
    for (const field of ["service", "worker_version", "git_commit", "build_time", "deployed_at"] as const) {
      if (typeof data[field] !== "string" || data[field]!.trim() === "") {
        throw new Error(`版本文件缺少字段: ${field}`);
      }
    }

    return {
      service: data.service!.trim(),
      worker_version: data.worker_version!.trim(),
      git_commit: data.git_commit!.trim(),
      build_time: data.build_time!.trim(),
      deployed_at: data.deployed_at!.trim()
    };
  }
}
