import type { InputFieldRule, InputRules } from "./rules-loader.js";

export interface ListingRequirements {
  raw: string;
  brand: string;
  keywords: string[];
  category: string;
  values: Record<string, string | string[]>;
}

function normalizeLines(input: string): string[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());
}

function normalizeMarker(value: string): string {
  return value.replace(/^\ufeff/, "").trim();
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

function inferFromH1FirstToken(lines: string[]): string {
  const h1 = lines.find((line) => line.startsWith("# "));
  if (!h1) {
    return "";
  }
  const text = h1.slice(2).trim();
  const first = text.split(/[\s（(]/)[0]?.trim();
  return first ?? "";
}

function parseInlineLabel(lines: string[], labels: string[]): string {
  const normalizedLabels = labels.map((v) => v.trim()).filter(Boolean);
  for (const line of lines) {
    for (const label of normalizedLabels) {
      const re = new RegExp(`^${escapeRegex(label)}\\s*[:：]\\s*(.+)$`, "i");
      const m = re.exec(line);
      if (m && m[1] && m[1].trim()) {
        return m[1].trim();
      }
    }
  }
  return "";
}

function extractField(lines: string[], field: InputFieldRule): string | string[] {
  if (field.capture === "inline_label") {
    const value = parseInlineLabel(lines, field.labels ?? []);
    if (value) {
      return value;
    }
    if (field.fallback_from_h1_first_token) {
      const inferred = inferFromH1FirstToken(lines);
      if (inferred) {
        return inferred;
      }
    }
    return field.fallback ?? "";
  }

  const sectionLines = extractSection(lines, headingMatcherByAliases(field.heading_aliases ?? []))
    .map(stripListPrefix)
    .filter((line) => line && !line.startsWith("#"));

  if (field.type === "list") {
    return sectionLines;
  }
  return sectionLines.join(" ").trim();
}

export function parseRequirements(inputMarkdown: string, inputRules: InputRules): ListingRequirements {
  const lines = normalizeLines(inputMarkdown);
  const values: Record<string, string | string[]> = {};
  for (const field of inputRules.fields) {
    values[field.key] = extractField(lines, field);
  }

  const brand = typeof values.brand === "string" ? values.brand : "";
  const category = typeof values.category === "string" ? values.category : "";
  const keywords = Array.isArray(values.keywords) ? values.keywords : [];

  return {
    raw: inputMarkdown,
    brand,
    keywords,
    category,
    values
  };
}

export function inputMatchesMarker(inputMarkdown: string, inputRules: InputRules): boolean {
  const expected = normalizeMarker(inputRules.file_discovery.marker);
  if (!expected) {
    return true;
  }
  const firstLine = inputMarkdown.replace(/\r\n/g, "\n").split("\n", 1)[0] ?? "";
  return normalizeMarker(firstLine) === expected;
}
