import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptMarkdownContentForValidation,
  buildTranslationReusePlanForTest,
  compactSectionRequirementsRawForPromptForTest,
  formatJSONArrayContent,
  resolveRuntimeTeamAttemptsForTest,
  resolveRuntimeTeamMaxTurnsForTest,
  shouldRunPromptPlanningForTest,
  scoreRuntimeCandidateForTest,
  summarizeRuntimeCandidateSelectionForTest
} from "./generation-service.js";
import type { SectionRule } from "./rules-loader.js";

test("formatJSONArrayContent emits the required JSON object shape for bullets output", () => {
  const result = formatJSONArrayContent(
    [
      "Package Contents: line one.",
      "Dimensions: line two."
    ].join("\n"),
    "bullets"
  );

  assert.deepEqual(JSON.parse(result), {
    bullets: [
      "Package Contents: line one.",
      "Dimensions: line two."
    ]
  });
});

test("adaptMarkdownContentForValidation merges extra paragraphs and closes sentence endings", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 2,
      max_paragraphs: 2,
      require_complete_sentence_end: true
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 5,
      paragraph_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const result = adaptMarkdownContentForValidation(
    "First paragraph without end\n\nSecond paragraph stays.\n\nThird paragraph joins",
    rule
  );

  assert.equal(result.content, "First paragraph without end.\n\nSecond paragraph stays. Third paragraph joins.");
});

test("adaptMarkdownContentForValidation strips agent meta preamble before description content", () => {
  const rule: SectionRule = {
    section: "description",
    language: "en",
    instruction: "generate description",
    constraints: {
      min_paragraphs: 1,
      max_paragraphs: 2,
      require_complete_sentence_end: true
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "markdown"
    }
  };

  const result = adaptMarkdownContentForValidation(
    "完美！校验通过，现在输出最终内容。\n\nActual description paragraph.",
    rule
  );

  assert.equal(result.content, "Actual description paragraph.");
});

test("scoreRuntimeCandidateForTest keeps normalized bullets text instead of re-parsing it as JSON", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 2,
      min_chars_per_line: 1,
      max_chars_per_line: 400
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    "Package Contents: line one.\nDimensions: line two."
  );

  assert.equal(result.normalizedContent, "Package Contents: line one.\nDimensions: line two.");
});

test("summarizeRuntimeCandidateSelectionForTest keeps candidate indexes and selected winner for trace output", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 10,
      max_chars: 20
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const summary = summarizeRuntimeCandidateSelectionForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    [
      { candidateIndex: 2, content: "Colorful Paper Lanterns" },
      { candidateIndex: 5, content: "Paper Lanterns" }
    ]
  );

  assert.equal(summary.selected_candidate_index, 5);
  assert.equal(summary.candidates[0]?.candidate_index, 2);
  assert.equal(summary.candidates[1]?.candidate_index, 5);
  assert.equal(summary.candidates[1]?.selected, true);
  assert.equal(summary.candidates[1]?.error_count, 0);
});

test("summarizeRuntimeCandidateSelectionForTest keeps failed candidates with failure reasons in trace output", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 10,
      max_chars_per_line: 300
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const summary = summarizeRuntimeCandidateSelectionForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    [
      { candidateIndex: 1, error: "第2条长度不满足约束: 235" },
      { candidateIndex: 2, content: "Feature Focus: colorful paper lanterns for classroom decor." }
    ]
  );

  assert.equal(summary.selected_candidate_index, 2);
  assert.equal(summary.candidates[0]?.candidate_index, 1);
  assert.equal(summary.candidates[0]?.failure_reason, "第2条长度不满足约束: 235");
  assert.equal(summary.candidates[0]?.selected, false);
  assert.equal(summary.candidates[1]?.candidate_index, 2);
  assert.equal(summary.candidates[1]?.selected, true);
});

test("scoreRuntimeCandidateForTest tolerates trailing prose after bullets JSON output", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 2,
      min_chars_per_line: 1,
      max_chars_per_line: 400
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    `${JSON.stringify({
      bullets: [
        "Package Contents: line one.",
        "Dimensions: line two."
      ]
    })}\n\n这些是最终内容。`
  );

  assert.equal(result.normalizedContent, "Package Contents: line one.\nDimensions: line two.");
});

test("scoreRuntimeCandidateForTest lightly compresses borderline overlong bullet lines before validation", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 1,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Package Contents: This set includes 12 premium durable versatile **Paper Lanterns** designed for versatile decorative use. Our **Paper Lanterns Decorative** collection features durable construction, and these vibrant **Colorful Paper Lanterns** are perfect for creating vibrant displays in various settings with easy assembly.";

  assert.ok(rawLine.length > 300);

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns Decorative\*\*/);
  assert.match(result.normalizedContent, /\*\*Colorful Paper Lanterns\*\*/);
});

test("scoreRuntimeCandidateForTest compresses real-world filler phrases in slightly overlong classroom bullet lines", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Color: Featuring a vibrant colorful plaid pattern that adds visual appeal to any setting, these lanterns serve as beautiful **Hanging Classroom Decoration** elements. They function effectively as **ceiling hanging Classroom decor** and also work well for **wedding decorations** events, parties, and classroom displays.";

  assert.equal(rawLine.length, 319);

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*Hanging Classroom Decoration\*\*/);
  assert.match(result.normalizedContent, /\*\*ceiling hanging Classroom decor\*\*/);
  assert.match(result.normalizedContent, /\*\*wedding decorations\*\*/);
});

test("scoreRuntimeCandidateForTest compresses package and dimensions bullet patterns seen in runtime failure logs", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const packageLine =
    "Package Contents: The 12-pack of **Paper Lanterns** includes everything you need for immediate use, providing a complete set of **Paper Lanterns Decorative** items that are ready to transform any space. These **Colorful Paper Lanterns** create a cheerful display for classrooms, events, and seasonal decorating moments.";
  const dimensionsLine =
    "Dimensions: Each lantern measures 10x10 inches, creating an ideal size for **hanging paper lanterns** that make a statement without overwhelming the space. The perfectly proportioned **Hanging Decor** ensures visual impact while keeping **Paper Hanging Decorations** easy to place across classrooms and parties.";

  assert.equal(packageLine.length, 319);
  assert.equal(dimensionsLine.length, 311);

  const packageResult = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [packageLine]
    })
  );
  const dimensionsResult = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [dimensionsLine]
    })
  );

  assert.equal(packageResult.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(dimensionsResult.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(packageResult.normalizedContent.length <= 300);
  assert.ok(dimensionsResult.normalizedContent.length <= 300);
  assert.match(packageResult.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(packageResult.normalizedContent, /\*\*Paper Lanterns Decorative\*\*/);
  assert.match(packageResult.normalizedContent, /\*\*Colorful Paper Lanterns\*\*/);
  assert.match(dimensionsResult.normalizedContent, /\*\*hanging paper lanterns\*\*/);
  assert.match(dimensionsResult.normalizedContent, /\*\*Hanging Decor\*\*/);
  assert.match(dimensionsResult.normalizedContent, /\*\*Paper Hanging Decorations\*\*/);
});

test("scoreRuntimeCandidateForTest compresses borderline overlong keyword-order classroom bullet lines", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Classroom Display: These lanterns pair naturally with **ceiling hanging decor**, blend smoothly into **hanging ceiling decor**, and complete **Classroom Decoration** themes for back to school rooms, reading corners, bulletin board backdrops, welcome walls, and everyday seasonal displays with easy setup.";

  assert.ok(rawLine.length > 300);

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*ceiling hanging decor\*\*/);
  assert.match(result.normalizedContent, /\*\*hanging ceiling decor\*\*/);
  assert.match(result.normalizedContent, /\*\*Classroom Decoration\*\*/);
});

test("scoreRuntimeCandidateForTest compresses first-attempt bullets patterns seen in latest runtime retries", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const packageLine =
    "Package Contents: Receive a complete set of 12 **Paper Lanterns** for immediate use in your classroom decor projects. These **Paper Lanterns Decorative** pieces are ready to hang, offering a practical solution for transformed ceilings and cheerful displays with **Colorful Paper Lanterns** for school events and parties.";
  const dimensionsLine =
    "Dimensions: Each lantern measures a perfect 10*10 inches, creating substantial visual impact as **hanging paper lanterns**. This ideal size ensures they serve as **Hanging Decor** pieces that fill classroom ceilings with presence while keeping **Paper Hanging Decorations** easy to suspend across events.";
  const usageLine =
    "Usage: Primarily designed as **chinese lanterns** that excel in classroom ceiling applications for educational environments. These **Ball Lanterns Lamps** provide excellent illumination and decorative appeal for academic celebrations while remaining suitable for **summer party decorations** and seasonal school events.";

  assert.equal(packageLine.length, 320);
  assert.equal(dimensionsLine.length, 304);
  assert.equal(usageLine.length, 319);

  for (const line of [packageLine, dimensionsLine, usageLine]) {
    const result = scoreRuntimeCandidateForTest(
      {
        brand: "gisgfim",
        category: "Paper Lanterns",
        keywords: [],
        raw: "# raw",
        values: {}
      },
      rule,
      JSON.stringify({
        bullets: [line]
      })
    );

    assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
    assert.ok(result.normalizedContent.length <= 300);
  }
});

test("scoreRuntimeCandidateForTest strips agent meta preamble from title candidates", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 10,
      max_chars: 200
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    "校验通过，现在输出最终标题：\n\ngisgfim Paper Lanterns Title"
  );

  assert.equal(result.normalizedContent, "gisgfim Paper Lanterns Title");
});

test("scoreRuntimeCandidateForTest strips title meta variants seen in real e2e output", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 10,
      max_chars: 200
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "markdown"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [],
      raw: "# raw",
      values: {}
    },
    rule,
    "完美！标题已经通过了所有验证。让我输出最终的标题：\n\ngisgfim Paper Lanterns Decorative Title"
  );

  assert.equal(result.normalizedContent, "gisgfim Paper Lanterns Decorative Title");
});

test("scoreRuntimeCandidateForTest lightly compresses borderline overlong runtime title candidates", () => {
  const rule: SectionRule = {
    section: "title",
    language: "en",
    instruction: "generate title",
    constraints: {
      min_chars: 100,
      max_chars: 200,
      tolerance_chars: 20,
      must_contain: [
        "brand",
        "top_keywords"
      ]
    },
    execution: {
      retries: 3,
      repair_mode: "whole",
      generation_mode: "whole"
    },
    output: {
      format: "text"
    }
  };

  const rawTitle =
    "gisgfim Paper Lanterns Paper Lanterns Decorative Colorful Paper Lanterns, 12 Pack 10x10 Inch Colorful Plaid Classroom Hanging Decor, DIY Ceiling Decorations for Wedding Baby Shower Summer Party Classroom Events and Back to School Decor";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    rawTitle
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 220);
  assert.match(result.normalizedContent, /\bPaper Lanterns\b/);
  assert.match(result.normalizedContent, /\bPaper Lanterns Decorative\b/);
  assert.match(result.normalizedContent, /\bColorful Paper Lanterns\b/);
});

test("scoreRuntimeCandidateForTest compresses runtime package bullet phrasing seen in failure logs", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 200,
      max_chars_per_line: 270,
      tolerance_chars: 30,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 3,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Package Contents: This set includes 12 **Paper Lanterns** ready for immediate classroom decoration, offering a full **Paper Lanterns Decorative** solution that includes all necessary hanging accessories for easy setup. These **Colorful Paper Lanterns** keep displays bright for seasonal classroom use.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.ok(result.normalizedContent.length <= 300);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns\*\*/);
  assert.match(result.normalizedContent, /\*\*Paper Lanterns Decorative\*\*/);
  assert.match(result.normalizedContent, /\*\*Colorful Paper Lanterns\*\*/);
});

test("scoreRuntimeCandidateForTest requires lowercase embedded bullet keywords when rule enables it", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 1,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true,
        lowercase: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Package Details: This classroom set includes **Paper Lanterns** for hanging displays and keeps setup simple. It adds enough value for seasonal décor and school events without wasting useful package information.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: ["Paper Lanterns"],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.match(result.errors.join("\n"), /关键词顺序埋入不满足/);
});

test("scoreRuntimeCandidateForTest validates bullet heading word count", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 1,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true,
        lowercase: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Usage: This classroom set uses **paper lanterns** to create a bright display for seasonal learning spaces. It keeps setup manageable while leaving enough detail for repeated events and everyday decorative use.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: ["Paper Lanterns"],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.match(result.errors.join("\n"), /小标题词数不满足约束/);
});

test("scoreRuntimeCandidateForTest compresses overlong lowercase runtime bullet candidates under new syl limits", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 1,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 3,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true,
        lowercase: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 1
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const rawLine =
    "Complete Set Ready: This package includes 12 ready-to-use **paper lanterns** measuring 10x10 inches each, offering immediate classroom transformation with **paper lanterns decorative** appeal. The **colorful paper lanterns** add bright seasonal energy for school displays, welcome walls, reading corners, themed parties, and everyday classroom decorating.";

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "Paper Lanterns",
        "Paper Lanterns Decorative",
        "Colorful Paper Lanterns"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [rawLine]
    })
  );

  assert.equal(result.errors.filter((item) => item.includes("长度不满足约束")).length, 0);
  assert.equal(result.errors.filter((item) => item.includes("关键词顺序埋入不满足")).length, 0);
  assert.ok(result.normalizedContent.length >= 240);
  assert.ok(result.normalizedContent.length <= 300);
});

test("scoreRuntimeCandidateForTest rejects bullet lines below hard minimum even when tolerance exists", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 2,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 6,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true,
        lowercase: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 2
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "ceiling hanging decor",
        "hanging ceiling decor",
        "classroom decoration",
        "chinese lanterns",
        "ball lanterns lamps",
        "summer party decorations"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [
        "Reusable Material: **ceiling hanging decor** store flat and reuse across lessons, holidays, and school events. **hanging ceiling decor** fold down after use, and **classroom decoration** help keep displays neat for the next celebration.",
        "Classroom Application: **chinese lanterns** suit classroom celebrations, bulletin boards, and themed activities. **ball lanterns lamps** add soft impact, and **summer party decorations** support school parties and quick seasonal refreshes."
      ]
    })
  );

  assert.match(result.errors.join("\n"), /第1条长度不满足约束/);
  assert.match(result.errors.join("\n"), /第2条长度不满足约束/);
});

test("scoreRuntimeCandidateForTest keeps fallback bullet lines above hard minimum for later slots", () => {
  const rule: SectionRule = {
    section: "bullets",
    language: "en",
    instruction: "generate bullets",
    constraints: {
      line_count: 5,
      min_chars_per_line: 240,
      max_chars_per_line: 250,
      tolerance_chars: 50,
      heading_min_words: 2,
      heading_max_words: 4,
      require_complete_sentence_end: true,
      forbid_dangling_tail: true,
      keyword_embedding: {
        enabled: true,
        min_total: 15,
        enforce_order: true,
        exact_match: true,
        no_split: true,
        bold_wrapper: true,
        lowercase: true
      }
    },
    execution: {
      retries: 3,
      repair_mode: "item",
      generation_mode: "sentence",
      sentence_count: 5
    },
    output: {
      format: "json",
      json_array_field: "bullets"
    }
  };

  const result = scoreRuntimeCandidateForTest(
    {
      brand: "gisgfim",
      category: "Paper Lanterns",
      keywords: [
        "paper lanterns",
        "paper lanterns decorative",
        "colorful paper lanterns",
        "hanging paper lanterns",
        "hanging decor",
        "paper hanging decorations",
        "ceiling hanging decor",
        "hanging ceiling decor",
        "classroom decoration",
        "hanging classroom decoration",
        "ceiling hanging classroom decor",
        "wedding decorations",
        "chinese lanterns",
        "ball lanterns lamps",
        "summer party decorations"
      ],
      raw: "# raw",
      values: {}
    },
    rule,
    JSON.stringify({
      bullets: [
        "Complete Set Ready: This package includes 12 ready-to-use **paper lanterns** measuring 10x10 inches each, offering immediate classroom transformation with **paper lanterns decorative** appeal. The **colorful paper lanterns** add bright seasonal energy for school displays, welcome walls, reading corners, themed parties, and everyday classroom decorating.",
        "installation Process: These **hanging paper lanterns** open quickly for ceilings and walls across busy classrooms with simple setup steps and no special tools needed at all. The **hanging decor** saves time for teachers, and **paper hanging decorations** create layered color for welcome days, reading corners, party tables, and photo backdrops across the room.",
        "Reusable Material: These **ceiling hanging decor** pieces stay easy to fold, easy to store, and easy to reuse after lessons, parties, and seasonal decorating changes throughout the year. The **hanging ceiling decor** supports repeated classroom refreshes, and **classroom decoration** keeps displays organized with practical color and visible themed structure for students.",
        "Plaid Design: The **hanging classroom decoration** adds bright plaid color for school spaces while keeping displays tidy, visible, and cheerful during welcome weeks, class parties, and craft activities. The **ceiling hanging classroom decor** helps anchor focal points, and **wedding decorations** styling keeps tables, doors, and corners looking neat from every angle.",
        "Classroom Application: These **chinese lanterns** work across classroom celebrations, bulletin boards, reading corners, and themed activity tables while still staying light, easy to move, and easy to hang for teachers. The **ball lanterns lamps** add soft visual impact, and **summer party decorations** support seasonal refreshes, school events, and reusable party setups across indoor spaces."
      ]
    })
  );

  const lines = result.normalizedContent.split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines[2]!.length >= 240, `line 3 too short: ${lines[2]!.length}`);
  assert.ok(lines[4]!.length >= 240, `line 5 too short: ${lines[4]!.length}`);
});

test("buildTranslationReusePlanForTest reuses unchanged runtime translations and only marks repaired sections for re-translation", () => {
  const result = buildTranslationReusePlanForTest(
    {
      title: "title-en-v1",
      bullets: "bullets-en-v1",
      description: "description-en-v1"
    },
    {
      title: "title-en-v1",
      bullets: "bullets-en-v2",
      description: "description-en-v1"
    },
    {
      category_cn: "分类-cn",
      keywords_cn: "关键词-cn",
      title_cn: "标题-cn-v1",
      bullets_cn: "五点-cn-v1",
      description_cn: "描述-cn-v1"
    }
  );

  assert.deepEqual(result.reusedTranslations, {
    category_cn: "分类-cn",
    keywords_cn: "关键词-cn",
    title_cn: "标题-cn-v1",
    description_cn: "描述-cn-v1"
  });
  assert.deepEqual(result.pendingSectionKeys, ["bullets"]);
});

test("resolveRuntimeTeamAttemptsForTest defaults runtime agent team retries to one whole-run attempt", () => {
  assert.equal(resolveRuntimeTeamAttemptsForTest({}), 1);
  assert.equal(resolveRuntimeTeamAttemptsForTest({ api_attempts: 0 }), 1);
  assert.equal(resolveRuntimeTeamAttemptsForTest({ api_attempts: 1 }), 1);
  assert.equal(resolveRuntimeTeamAttemptsForTest({ api_attempts: 3 }), 3);
});

test("resolveRuntimeTeamMaxTurnsForTest keeps bullets high but tightens reviewer-free sections", () => {
  assert.equal(resolveRuntimeTeamMaxTurnsForTest("bullets", true), 12);
  assert.equal(resolveRuntimeTeamMaxTurnsForTest("title", true), 8);
  assert.equal(resolveRuntimeTeamMaxTurnsForTest("description", false), 6);
});

test("compactSectionRequirementsRawForPromptForTest removes duplicated keyword and category blocks for description", () => {
  const raw = [
    "# 基础信息",
    "",
    "品牌名: gisgfim",
    "颜色: Colorful plaid",
    "",
    "# 关键词库",
    "",
    "Paper Lanterns",
    "",
    "Classroom Decoration",
    "",
    "# 分类",
    "",
    "Paper Lanterns",
    "",
    "# 特殊关键要求",
    "",
    "适用场景最主要是教室悬挂装饰"
  ].join("\n");

  const result = compactSectionRequirementsRawForPromptForTest(raw, "description");

  assert.match(result, /品牌名: gisgfim/);
  assert.match(result, /适用场景最主要是教室悬挂装饰/);
  assert.doesNotMatch(result, /Paper Lanterns\n\nClassroom Decoration/);
  assert.doesNotMatch(result, /# 分类/);
});

test("shouldRunPromptPlanningForTest disables legacy planner brief in runtime-native execution", () => {
  assert.equal(
    shouldRunPromptPlanningForTest({
      generationConfig: {
        planning: {
          enabled: true,
          retries: 1,
          system_prompt: "plan",
          user_prompt: "plan"
        }
      }
    } as any),
    false
  );
  assert.equal(
    shouldRunPromptPlanningForTest({
      generationConfig: {
        planning: {
          enabled: false,
          retries: 1,
          system_prompt: "plan",
          user_prompt: "plan"
        }
      }
    } as any),
    false
  );
});
