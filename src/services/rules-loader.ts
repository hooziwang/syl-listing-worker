import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { parse as parseYAML } from "yaml";

export interface SectionRule {
  section: string;
  language: string;
  instruction: string;
  constraints: Record<string, unknown>;
  execution: {
    retries: number;
    repair_mode?: string;
  };
  output: {
    format: string;
  };
}

export interface TenantRules {
  version: string;
  sections: Map<string, SectionRule>;
}

const cache = new Map<string, TenantRules>();

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export async function loadTenantRules(
  archivePath: string,
  tenantId: string,
  rulesVersion: string
): Promise<TenantRules> {
  const key = `${tenantId}:${rulesVersion}`;
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const workdir = await mkdtemp(join(tmpdir(), `syl-rules-${tenantId}-${rulesVersion}-`));
  await extract({
    file: archivePath,
    cwd: workdir,
    gzip: true
  });

  const rulesDir = join(workdir, "tenant", "rules");
  const files = await readdir(rulesDir);
  const sections = new Map<string, SectionRule>();

  for (const file of files) {
    if (!file.endsWith(".yaml")) {
      continue;
    }

    const raw = await readFile(join(rulesDir, file), "utf8");
    const doc = parseYAML(raw) as Partial<SectionRule>;
    if (!doc || typeof doc.section !== "string" || typeof doc.instruction !== "string") {
      continue;
    }

    sections.set(doc.section, {
      section: doc.section,
      language: doc.language ?? "en",
      instruction: doc.instruction,
      constraints: (doc.constraints as Record<string, unknown>) ?? {},
      execution: {
        retries: asNumber((doc.execution as { retries?: unknown } | undefined)?.retries, 3),
        repair_mode: (doc.execution as { repair_mode?: string } | undefined)?.repair_mode
      },
      output: {
        format: (doc.output as { format?: string } | undefined)?.format ?? "text"
      }
    });
  }

  const parsed: TenantRules = { version: rulesVersion, sections };
  cache.set(key, parsed);
  return parsed;
}
