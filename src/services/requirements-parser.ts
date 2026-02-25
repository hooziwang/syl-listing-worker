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

function sectionContent(lines: string[], heading: string): string[] {
  const startIndex = lines.findIndex((line) => line.toLowerCase() === `## ${heading}`.toLowerCase());
  if (startIndex < 0) {
    return [];
  }

  const out: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      break;
    }
    if (line) {
      out.push(line);
    }
  }
  return out;
}

function inferBrand(lines: string[]): string {
  const h1 = lines.find((line) => line.startsWith("# "));
  if (h1) {
    const text = h1.slice(2).trim();
    const first = text.split(/[\s（(]/)[0]?.trim();
    if (first) {
      return first;
    }
  }

  const brandLine = lines.find((line) => line.startsWith("品牌") || line.startsWith("Brand"));
  if (brandLine) {
    const parts = brandLine.split(/[:：]/);
    if (parts.length > 1 && parts[1].trim()) {
      return parts[1].trim();
    }
  }

  return "UnknownBrand";
}

export function parseRequirements(inputMarkdown: string): ListingRequirements {
  const lines = normalizeLines(inputMarkdown);
  const keywords = sectionContent(lines, "关键词").filter((line) => !line.startsWith("#"));
  const categoryList = sectionContent(lines, "分类");
  const category = categoryList.join(" ").trim();
  const brand = inferBrand(lines);

  return {
    raw: inputMarkdown,
    brand,
    keywords,
    category
  };
}
