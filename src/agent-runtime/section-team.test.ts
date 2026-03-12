import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { tool } from "@openai/agents";
import { buildSectionAgentTeam } from "./section-team.js";

test("buildSectionAgentTeam tells repairer to never invent transfer tools", () => {
  const validateTool = tool({
    name: "validate_section_candidate",
    description: "validate",
    parameters: z.object({
      content: z.string()
    }),
    execute: async () => JSON.stringify({ ok: true, errors: [] })
  });

  const team = buildSectionAgentTeam({
    section: "bullets",
    step: "bullets_runtime_team_candidate_1",
    validateToolName: "check_section_candidate",
    plannerRuntime: {
      model: "deepseek-chat",
      modelSettings: {}
    },
    writerRuntime: {
      model: "deepseek-chat",
      modelSettings: {}
    },
    validateTool,
    writerInstructions: "writer",
    reviewerInstructions: "reviewer",
    repairInstructions: "repair"
  });

  assert.ok(team.repairerAgent);
  assert.equal(team.repairerAgent?.handoffs.length, 0);
  assert.match(String(team.repairerAgent?.instructions), /不要调用任何 transfer_to_/);
});

test("buildSectionAgentTeam makes validation an explicit tool instead of a handoff target", () => {
  const validateTool = tool({
    name: "validate_section_candidate",
    description: "validate",
    parameters: z.object({
      content: z.string()
    }),
    execute: async () => JSON.stringify({ ok: true, errors: [] })
  });

  const team = buildSectionAgentTeam({
    section: "title",
    step: "title_runtime_team_candidate_1",
    validateToolName: "check_section_candidate",
    plannerRuntime: {
      model: "deepseek-chat",
      modelSettings: {}
    },
    writerRuntime: {
      model: "deepseek-chat",
      modelSettings: {}
    },
    validateTool,
    writerInstructions: "writer",
    reviewerInstructions: "reviewer",
    repairInstructions: "repair"
  });

  assert.match(String(team.writerAgent.instructions), /不是 agent，也不是 handoff/);
  assert.match(String(team.reviewerAgent?.instructions), /不是 agent，也不是 handoff/);
  assert.match(String(team.repairerAgent?.instructions), /不是 agent，也不是 handoff/);
});

test("buildSectionAgentTeam filters tool history before handoff to repairer", () => {
  const validateTool = tool({
    name: "validate_section_candidate",
    description: "validate",
    parameters: z.object({
      content: z.string()
    }),
    execute: async () => JSON.stringify({ ok: true, errors: [] })
  });

  const team = buildSectionAgentTeam({
    section: "bullets",
    step: "bullets_runtime_team_candidate_2",
    validateToolName: "check_section_candidate",
    plannerRuntime: {
      model: "deepseek-chat",
      modelSettings: {}
    },
    writerRuntime: {
      model: "deepseek-chat",
      modelSettings: {}
    },
    validateTool,
    writerInstructions: "writer",
    reviewerInstructions: "reviewer",
    repairInstructions: "repair"
  });

  const reviewerRepairHandoff = team.reviewerAgent?.handoffs[0] as { inputFilter?: unknown } | undefined;
  const writerRepairHandoff = team.writerAgent.handoffs.find((item) => "agentName" in item && item.agentName === team.repairerAgent?.name) as
    | { inputFilter?: unknown }
    | undefined;

  assert.equal(typeof reviewerRepairHandoff?.inputFilter, "function");
  assert.equal(typeof writerRepairHandoff?.inputFilter, "function");
});
