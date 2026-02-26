import type { InputRules } from "./rules-loader.js";

export interface ListingRequirements {
  raw: string;
  brand: string;
  keywords: string[];
  category: string;
}

function normalizeLines(input: string): string[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());
}

type HeadingMatch = (normalizedHeading: string) => boolean;

function parseHeading(line: string): string | null {
  const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

function normalizeHeadingText(text: string): string {
  return text.toLowerCase().replace(/[\s:：()（）【】\[\]<>《》,，.。;；!！?？'"`~\-_/|]+/g, "");
}

function normalizeAlias(value: string): string {
  return normalizeHeadingText(value);
}

function extractSection(lines: string[], isTargetHeading: HeadingMatch): string[] {
  let inTargetSection = false;
  const out: string[] = [];

  for (const line of lines) {
    const headingText = parseHeading(line);
    if (headingText) {
      const normalized = normalizeHeadingText(headingText);
      if (isTargetHeading(normalized)) {
        inTargetSection = true;
        continue;
      }
      if (inTargetSection) {
        break;
      }
      continue;
    }

    if (!inTargetSection) {
      continue;
    }
    if (line) {
      out.push(line);
    }
  }
  return out;
}

function stripListPrefix(line: string): string {
  return line
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .trim();
}

function headingMatcherByAliases(aliases: string[]): HeadingMatch {
  const normalizedAliases = aliases.map(normalizeAlias).filter(Boolean);
  return (normalizedHeading: string): boolean =>
    normalizedAliases.some((alias) => normalizedHeading.includes(alias));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferBrand(lines: string[], inputRules: InputRules): string {
  const labels = inputRules.brand.labels.map((v) => v.trim()).filter(Boolean);
  for (const line of lines) {
    for (const label of labels) {
      const re = new RegExp(`^${escapeRegex(label)}\\s*[:：]\\s*(.+)$`, "i");
      const m = re.exec(line);
      if (m && m[1] && m[1].trim()) {
        return m[1].trim();
      }
    }
  }

  const h1 = lines.find((line) => line.startsWith("# "));
  if (h1) {
    const text = h1.slice(2).trim();
    const first = text.split(/[\s（(]/)[0]?.trim();
    if (first) {
      return first;
    }
  }
  return inputRules.brand.fallback || "UnknownBrand";
}

export function parseRequirements(inputMarkdown: string, inputRules: InputRules): ListingRequirements {
  const lines = normalizeLines(inputMarkdown);

  const keywords = extractSection(lines, headingMatcherByAliases(inputRules.keywords.heading_aliases))
    .map(stripListPrefix)
    .filter((line) => line && !line.startsWith("#"));

  const category = extractSection(lines, headingMatcherByAliases(inputRules.category.heading_aliases))
    .map(stripListPrefix)
    .join(" ")
    .trim();

  const brand = inferBrand(lines, inputRules);

  return {
    raw: inputMarkdown,
    brand,
    keywords,
    category
  };
}
