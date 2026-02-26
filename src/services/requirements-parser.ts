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

function isKeywordsHeading(normalizedHeading: string): boolean {
  return normalizedHeading.includes("关键词") || normalizedHeading.includes("keyword");
}

function isCategoryHeading(normalizedHeading: string): boolean {
  return normalizedHeading.includes("分类") || normalizedHeading.includes("category") || normalizedHeading.includes("类目");
}

function stripListPrefix(line: string): string {
  return line
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)、]\s*/, "")
    .trim();
}

function inferBrand(lines: string[]): string {
  const brandLine = lines.find((line) => /^(品牌名|品牌|brand)\s*[:：]/i.test(line));
  if (brandLine) {
    const parts = brandLine.split(/[:：]/);
    if (parts.length > 1 && parts[1].trim()) {
      return parts[1].trim();
    }
  }

  const h1 = lines.find((line) => line.startsWith("# "));
  if (h1) {
    const text = h1.slice(2).trim();
    const first = text.split(/[\s（(]/)[0]?.trim();
    if (first && !["基础信息", "产品信息"].includes(first)) {
      return first;
    }
  }

  return "UnknownBrand";
}

export function parseRequirements(inputMarkdown: string): ListingRequirements {
  const lines = normalizeLines(inputMarkdown);
  const keywords = extractSection(lines, isKeywordsHeading)
    .map(stripListPrefix)
    .filter((line) => line && !line.startsWith("#"));
  const category = extractSection(lines, isCategoryHeading).map(stripListPrefix).join(" ").trim();
  const brand = inferBrand(lines);

  return {
    raw: inputMarkdown,
    brand,
    keywords,
    category
  };
}
