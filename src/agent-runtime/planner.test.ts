import test from "node:test";
import assert from "node:assert/strict";
import { executeRuntimeSections } from "./planner.js";
import type { AgentExecutionSpec, SectionExecutionPlan } from "./types.js";

function candidateContent(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object" || !("content" in candidate)) {
    return "";
  }
  const value = (candidate as { content?: string }).content;
  return typeof value === "string" ? value : "";
}

function candidateError(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object" || !("error" in candidate)) {
    return "";
  }
  const value = (candidate as { error?: string }).error;
  return typeof value === "string" ? value : "";
}

function createSpec(): AgentExecutionSpec {
  return {
    parallelGroups: [["title", "bullets"], ["description", "search_terms"]],
    sectionPlans: new Map([
      [
        "title",
      {
        section: "title",
        mode: "generate",
        plannerBlueprint: "section_planner",
        plannerModelProfile: "planner-default",
        writerBlueprint: "title_writer",
        reviewerBlueprint: "reviewer",
        repairerBlueprint: "repairer",
        candidateCount: 1
      }
      ],
      [
        "bullets",
        {
          section: "bullets",
          mode: "generate",
          plannerBlueprint: "section_planner",
          plannerModelProfile: "planner-default",
          writerBlueprint: "bullets_writer",
          reviewerBlueprint: "reviewer",
          repairerBlueprint: "repairer",
          candidateCount: 2
        }
      ],
      [
        "description",
        {
          section: "description",
          mode: "generate",
          plannerBlueprint: "section_planner",
          plannerModelProfile: "planner-default",
          writerBlueprint: "description_writer",
          reviewerBlueprint: "reviewer",
          repairerBlueprint: "repairer",
          candidateCount: 1
        }
      ],
      [
        "search_terms",
        {
          section: "search_terms",
          mode: "derive",
          candidateCount: 1
        }
      ]
    ]),
    translationPlan: {
      blueprint: "translation_specialist",
      modelProfile: "translator-default"
    },
    limits: {
      sectionConcurrency: 2,
      maxReviewRounds: 2
    }
  };
}

test("executeRuntimeSections runs each parallel group concurrently and translates after generation", async () => {
  const spec = createSpec();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  const result = await executeRuntimeSections(spec, {
    category: "patio decor",
    keywords: "solar lantern\noutdoor lantern",
    generateSection: async (plan, candidateIndex) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${plan.section}:${candidateIndex}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`end:${plan.section}:${candidateIndex}`);
      active -= 1;
      return `${plan.section}-candidate-${candidateIndex}`;
    },
    deriveSection: async (plan) => {
      events.push(`derive:${plan.section}`);
      return `${plan.section}-en`;
    },
    pickBestCandidate: async (plan, candidates) => {
      events.push(
        `pick:${plan.section}:${candidates.length}:${candidates.map((candidate) => candidate.candidateIndex).join(",")}`
      );
      return candidateContent(candidates[candidates.length - 1] ?? {}) ?? "";
    },
    translateValue: async (slot, value) => {
      events.push(`translate:${slot}`);
      return `${value}-cn`;
    }
  });

  assert.equal(maxActive, 3);
  assert.equal(result.sections.title, "title-candidate-1");
  assert.equal(result.sections.bullets, "bullets-candidate-2");
  assert.equal(result.sections.search_terms, "search_terms-en");
  assert.equal(result.translations.title_cn, "title-candidate-1-cn");
  assert.equal(result.translations.category_cn, "patio decor-cn");
  assert.ok(events.includes("pick:bullets:2:1,2"));
  assert.ok(events.indexOf("translate:title_cn") > events.indexOf("end:title:1"));
  assert.ok(events.indexOf("translate:description_cn") > events.indexOf("end:description:1"));
});

test("executeRuntimeSections ignores failed candidates when another candidate succeeds", async () => {
  const spec = createSpec();

  const result = await executeRuntimeSections(spec, {
    category: "patio decor",
    keywords: "solar lantern\noutdoor lantern",
    generateSection: async (plan, candidateIndex) => {
      if (plan.section === "bullets" && candidateIndex === 1) {
        throw new Error("candidate failed");
      }
      return `${plan.section}-candidate-${candidateIndex}`;
    },
    deriveSection: async (plan) => `${plan.section}-en`,
    pickBestCandidate: async (_plan, candidates) => candidateContent(candidates[candidates.length - 1] ?? {}),
    translateValue: async (_slot, value) => `${value}-cn`
  });

  assert.equal(result.sections.bullets, "bullets-candidate-2");
});

test("executeRuntimeSections throws when all candidates fail", async () => {
  const spec = createSpec();

  await assert.rejects(
    executeRuntimeSections(spec, {
      category: "patio decor",
      keywords: "solar lantern\noutdoor lantern",
      generateSection: async (plan) => {
        if (plan.mode === "generate") {
          throw new Error(`${plan.section} failed`);
        }
        return "";
      },
      deriveSection: async (plan) => `${plan.section}-en`,
      pickBestCandidate: async (_plan, candidates) => candidateContent(candidates[0] ?? {}),
      translateValue: async (_slot, value) => `${value}-cn`
    }),
    /title failed|bullets failed|description failed/
  );
});

test("executeRuntimeSections keeps slower candidates retrying until they settle for candidate scoring", async () => {
  const spec = createSpec();
  const attempts: string[] = [];

  const result = await executeRuntimeSections(spec, {
    category: "patio decor",
    keywords: "solar lantern\noutdoor lantern",
    generateSection: (async (
      plan: SectionExecutionPlan,
      candidateIndex: number,
      controls?: { shouldContinueRetries: () => boolean }
    ) => {
      if (plan.section !== "bullets") {
        return `${plan.section}-candidate-${candidateIndex}`;
      }
      if (candidateIndex === 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "bullets-candidate-2";
      }
      attempts.push(`candidate-${candidateIndex}:attempt-1`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (controls?.shouldContinueRetries() === false) {
        throw new Error("retry stopped before scoring");
      }
      attempts.push(`candidate-${candidateIndex}:attempt-2`);
      return "bullets-candidate-1-late";
    }) as any,
    deriveSection: async (plan) => `${plan.section}-en`,
    pickBestCandidate: async (_plan, candidates) => candidateContent(candidates[0] ?? {}),
    translateValue: async (_slot, value) => `${value}-cn`
  });

  assert.equal(result.sections.bullets, "bullets-candidate-1-late");
  assert.deepEqual(attempts, ["candidate-1:attempt-1", "candidate-1:attempt-2"]);
});

test("executeRuntimeSections translates independent slots concurrently", async () => {
  const spec = createSpec();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  await executeRuntimeSections(spec, {
    category: "patio decor",
    keywords: "solar lantern\noutdoor lantern",
    generateSection: async (plan, candidateIndex) => `${plan.section}-candidate-${candidateIndex}`,
    deriveSection: async (plan) => `${plan.section}-en`,
    pickBestCandidate: async (_plan, candidates) => candidateContent(candidates[0] ?? {}),
    translateValue: async (slot, value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${slot}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`end:${slot}`);
      active -= 1;
      return `${value}-cn`;
    }
  });

  assert.ok(maxActive > 1);
  assert.ok(events.indexOf("start:keywords_cn") < events.indexOf("end:category_cn"));
});

test("executeRuntimeSections waits for slower successful peers before picking the best candidate", async () => {
  const spec = createSpec();
  const started = Date.now();
  const picked: string[][] = [];

  const result = await executeRuntimeSections(spec, {
    category: "patio decor",
    keywords: "solar lantern\noutdoor lantern",
    generateSection: async (plan, candidateIndex) => {
      if (plan.section !== "bullets") {
        return `${plan.section}-candidate-${candidateIndex}`;
      }
      if (candidateIndex === 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "bullets-candidate-fast";
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      return "bullets-candidate-slow";
    },
    deriveSection: async (plan) => `${plan.section}-en`,
    pickBestCandidate: async (_plan, candidates) => {
      picked.push(candidates.map((candidate) => `${candidate.candidateIndex}:${candidateContent(candidate)}`));
      return candidateContent(candidates[0] ?? {});
    },
    translateValue: async (_slot, value) => `${value}-cn`
  });

  const durationMs = Date.now() - started;
  assert.equal(result.sections.bullets, "bullets-candidate-slow");
  assert.ok(durationMs >= 70, `expected waiting for slow peer before scoring, got ${durationMs}ms`);
  assert.ok(
    picked.some(
      (candidates) =>
        candidates.length === 2 &&
        candidates[0] === "1:bullets-candidate-slow" &&
        candidates[1] === "2:bullets-candidate-fast"
    )
  );
});

test("executeRuntimeSections passes failed candidates to pickBestCandidate for trace reporting", async () => {
  const spec = createSpec();
  const picked: string[] = [];

  const result = await executeRuntimeSections(spec, {
    category: "patio decor",
    keywords: "solar lantern\noutdoor lantern",
    generateSection: async (plan, candidateIndex) => {
      if (plan.section === "bullets" && candidateIndex === 1) {
        throw new Error("candidate 1 failed");
      }
      return `${plan.section}-candidate-${candidateIndex}`;
    },
    deriveSection: async (plan) => `${plan.section}-en`,
    pickBestCandidate: async (plan, candidates) => {
      if (plan.section === "bullets") {
        picked.push(
          ...candidates.map((candidate) =>
            candidateContent(candidate) != ""
              ? `#${candidate.candidateIndex}=${candidateContent(candidate)}`
              : `#${candidate.candidateIndex}!${candidateError(candidate)}`
          )
        );
      }
      const winner = candidates.find((candidate) => candidateContent(candidate) != "");
      return candidateContent(winner ?? {});
    },
    translateValue: async (_slot, value) => `${value}-cn`
  });

  assert.equal(result.sections.bullets, "bullets-candidate-2");
  assert.deepEqual(picked, ["#1!candidate 1 failed", "#2=bullets-candidate-2"]);
});

test("executeRuntimeSections aborts in-flight sibling sections after a fatal section failure", async () => {
  const spec = createSpec();
  const events: string[] = [];

  await assert.rejects(
    executeRuntimeSections(spec, {
      category: "patio decor",
      keywords: "solar lantern\noutdoor lantern",
      generateSection: async (
        _plan: SectionExecutionPlan,
        _candidateIndex: number,
        controls?: { shouldContinueRetries: () => boolean; signal: AbortSignal }
      ) => {
        if (_plan.section === "bullets") {
          throw new Error("bullets failed");
        }
        return await new Promise<string>((resolve, reject) => {
          const started = Date.now();
          const tick = () => {
            if (controls?.signal?.aborted || controls?.shouldContinueRetries() === false) {
              events.push(`${_plan.section}:aborted`);
              reject(new Error(`${_plan.section} aborted`));
              return;
            }
            if (Date.now() - started > 80) {
              events.push(`${_plan.section}:finished`);
              resolve(`${_plan.section}-late-success`);
              return;
            }
            setTimeout(tick, 5);
          };
          tick();
        });
      },
      deriveSection: async (plan: SectionExecutionPlan) => `${plan.section}-en`,
      pickBestCandidate: async (
        _plan: SectionExecutionPlan,
        candidates: Array<{ candidateIndex: number; content?: string; error?: string }>
      ) => candidateContent(candidates[0] ?? {}),
      translateValue: async (_slot: string, value: string) => `${value}-cn`
    } as any),
    /bullets failed/
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(events.includes("title:aborted"), `events=${events.join(",")}`);
  assert.ok(!events.includes("title:finished"), `events=${events.join(",")}`);
});

test("executeRuntimeSections reuses completed sections from checkpoint and skips regenerating them", async () => {
  const spec = createSpec();
  const generated: string[] = [];

  const result = await executeRuntimeSections(spec, {
    category: "patio decor",
    keywords: "solar lantern\noutdoor lantern",
    initialSections: {
      title: "cached-title",
      description: "cached-description"
    },
    generateSection: async (plan: SectionExecutionPlan, candidateIndex: number) => {
      generated.push(`${plan.section}:${candidateIndex}`);
      return `${plan.section}-candidate-${candidateIndex}`;
    },
    deriveSection: async (plan: SectionExecutionPlan) => `${plan.section}-en`,
    pickBestCandidate: async (
      _plan: SectionExecutionPlan,
      candidates: Array<{ candidateIndex: number; content?: string; error?: string }>
    ) => candidateContent(candidates[0] ?? {}),
    translateValue: async (_slot: string, value: string) => `${value}-cn`
  } as any);

  assert.equal(result.sections.title, "cached-title");
  assert.equal(result.sections.description, "cached-description");
  assert.deepEqual(generated, ["bullets:1", "bullets:2"]);
  assert.equal(result.translations.title_cn, "cached-title-cn");
  assert.equal(result.translations.description_cn, "cached-description-cn");
});
