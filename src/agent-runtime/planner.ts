import type { AgentExecutionSpec, SectionExecutionPlan } from "./types.js";

export interface RuntimeSectionExecutionResult {
  sections: Record<string, string>;
  translations: Record<string, string>;
}

export interface RuntimeSectionCandidate {
  candidateIndex: number;
  content: string;
}

export interface RuntimeSectionCandidateFailure {
  candidateIndex: number;
  error: string;
}

export type RuntimeSectionCandidateResult = RuntimeSectionCandidate | RuntimeSectionCandidateFailure;

function isRuntimeSectionCandidate(candidate: RuntimeSectionCandidateResult): candidate is RuntimeSectionCandidate {
  return "content" in candidate;
}

function isRuntimeSectionCandidateFailure(
  candidate: RuntimeSectionCandidateResult
): candidate is RuntimeSectionCandidateFailure {
  return "error" in candidate;
}

interface ExecuteRuntimeSectionsInput {
  category: string;
  keywords: string;
  initialSections?: Record<string, string>;
  onSectionComplete?: (section: string, value: string) => Promise<void> | void;
  generateSection: (
    plan: SectionExecutionPlan,
    candidateIndex: number,
    controls?: { shouldContinueRetries: () => boolean; signal: AbortSignal }
  ) => Promise<string>;
  deriveSection: (plan: SectionExecutionPlan) => Promise<string>;
  pickBestCandidate?: (plan: SectionExecutionPlan, candidates: RuntimeSectionCandidateResult[]) => Promise<string>;
  translateValue: (slot: string, value: string) => Promise<string>;
}

export async function executeRuntimeSections(
  spec: AgentExecutionSpec,
  input: ExecuteRuntimeSectionsInput
): Promise<RuntimeSectionExecutionResult> {
  const sections: Record<string, string> = { ...(input.initialSections ?? {}) };
  const executionController = new AbortController();
  let executionFailure: unknown;
  for (const group of spec.parallelGroups) {
    const results = await Promise.allSettled(
      group.map(async (section) => {
        const plan = spec.sectionPlans.get(section);
        if (!plan) {
          return;
        }
        if (Object.prototype.hasOwnProperty.call(sections, section)) {
          return;
        }
        if (plan.mode === "derive") {
          const value = await input.deriveSection(plan);
          sections[section] = value;
          await input.onSectionComplete?.(section, value);
          return;
        }
        const candidateCount = Math.max(1, plan.candidateCount);
        const candidatePromises = Array.from({ length: candidateCount }, async (_, index) => {
          const candidateIndex = index + 1;
          if (executionController.signal.aborted) {
            throw executionFailure instanceof Error ? executionFailure : new Error(String(executionFailure ?? "execution aborted"));
          }
          const content = await input.generateSection(plan, candidateIndex, {
            shouldContinueRetries: () => !executionController.signal.aborted,
            signal: executionController.signal
          });
          return {
            candidateIndex,
            content
          };
        });
        const candidateResults = await Promise.allSettled(candidatePromises);
        const settledCandidates: RuntimeSectionCandidateResult[] = candidateResults.map((result, index) => {
          const candidateIndex = index + 1;
          if (result.status === "fulfilled") {
            return result.value;
          }
          const reason = result.reason;
          return {
            candidateIndex,
            error: reason instanceof Error ? reason.message : String(reason)
          } satisfies RuntimeSectionCandidateFailure;
        });
        const successfulCandidates = settledCandidates.filter(isRuntimeSectionCandidate);
        if (successfulCandidates.length === 0) {
          const firstFailure = settledCandidates.find(isRuntimeSectionCandidateFailure);
          const reason = firstFailure?.error;
          throw new Error(reason || `${plan.section} generation failed`);
        }
        const value = input.pickBestCandidate
          ? await input.pickBestCandidate(plan, settledCandidates)
          : successfulCandidates[0]?.content ?? "";
        sections[section] = value;
        await input.onSectionComplete?.(section, value);
      }).map(async (task) => {
        try {
          await task;
        } catch (error) {
          if (!executionController.signal.aborted) {
            executionFailure = error;
            executionController.abort(error);
          }
          throw error;
        }
      })
    );
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (executionFailure) {
      throw executionFailure;
    }
    if (rejected) {
      throw rejected.reason;
    }
  }

  const orderedSections = spec.parallelGroups.flat().filter((section, index, all) => {
    return all.indexOf(section) === index && Object.prototype.hasOwnProperty.call(sections, section);
  });
  for (const section of Object.keys(sections)) {
    if (!orderedSections.includes(section)) {
      orderedSections.push(section);
    }
  }

  const translationEntries = await Promise.all(
    [
      { slot: "category_cn", value: input.category },
      { slot: "keywords_cn", value: input.keywords },
      ...orderedSections.map((section) => ({
        slot: `${section}_cn`,
        value: sections[section] ?? ""
      }))
    ].map(async ({ slot, value }) => [slot, await input.translateValue(slot, value)] as const)
  );
  const translations: Record<string, string> = Object.fromEntries(translationEntries);

  return {
    sections,
    translations
  };
}
