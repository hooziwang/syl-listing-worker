import type { AgentExecutionSpec, SectionExecutionPlan } from "./types.js";

export interface RuntimeSectionExecutionResult {
  sections: Record<string, string>;
  translations: Record<string, string>;
}

interface ExecuteRuntimeSectionsInput {
  category: string;
  keywords: string;
  generateSection: (
    plan: SectionExecutionPlan,
    candidateIndex: number,
    controls?: { shouldContinueRetries: () => boolean }
  ) => Promise<string>;
  deriveSection: (plan: SectionExecutionPlan) => Promise<string>;
  pickBestCandidate?: (plan: SectionExecutionPlan, candidates: string[]) => Promise<string>;
  translateValue: (slot: string, value: string) => Promise<string>;
}

export async function executeRuntimeSections(
  spec: AgentExecutionSpec,
  input: ExecuteRuntimeSectionsInput
): Promise<RuntimeSectionExecutionResult> {
  const sections: Record<string, string> = {};
  for (const group of spec.parallelGroups) {
    await Promise.all(
      group.map(async (section) => {
        const plan = spec.sectionPlans.get(section);
        if (!plan) {
          return;
        }
        if (plan.mode === "derive") {
          sections[section] = await input.deriveSection(plan);
          return;
        }
        const candidateCount = Math.max(1, plan.candidateCount);
        const candidateControl = {
          hasWinner: false
        };
        const candidatePromises = Array.from({ length: candidateCount }, async (_, index) => {
          const candidate = await input.generateSection(plan, index + 1, {
            shouldContinueRetries: () => candidateControl.hasWinner === false
          });
          candidateControl.hasWinner = true;
          return candidate;
        });
        let winner: string;
        try {
          winner = await Promise.any(candidatePromises);
        } catch (error) {
          if (error instanceof AggregateError && error.errors.length > 0) {
            throw error.errors[0];
          }
          throw error instanceof Error ? error : new Error(`${plan.section} generation failed`);
        }
        sections[section] = input.pickBestCandidate
          ? await input.pickBestCandidate(plan, [winner])
          : winner;
      })
    );
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
