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
  assert.equal(team.repairerAgent?.tools.length, 0);
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

  assert.doesNotMatch(String(team.writerAgent.instructions), /check_section_candidate/);
  assert.doesNotMatch(String(team.reviewerAgent?.instructions), /check_section_candidate/);
  assert.doesNotMatch(String(team.repairerAgent?.instructions), /check_section_candidate/);
  assert.equal(team.writerAgent.tools.length, 0);
  assert.equal(team.reviewerAgent?.tools.length, 0);
});

test("buildSectionAgentTeam no longer wires reviewer handoff to repairer inside the runtime team", () => {
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

  assert.equal(team.reviewerAgent?.handoffs.length, 0);
  assert.equal(team.writerAgent.handoffs.some((item) => "agentName" in item && item.agentName === team.repairerAgent?.name), false);
});

test("buildSectionAgentTeam forces writer to hand off to reviewer instead of finishing directly", () => {
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
    step: "bullets_runtime_team_candidate_3",
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

  assert.match(String(team.writerAgent.instructions), /若 reviewer 可用，完成候选稿后必须 handoff 给 reviewer/);
  assert.match(String(team.reviewerAgent?.instructions), /直接输出最终稿/);
});

test("buildSectionAgentTeam exposes only reviewer handoff to writer when reviewer exists", () => {
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
    step: "bullets_runtime_team_candidate_4",
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

  assert.equal(team.writerAgent.handoffs.length, 1);
  assert.equal("agentName" in team.writerAgent.handoffs[0], true);
  assert.equal(("agentName" in team.writerAgent.handoffs[0] ? team.writerAgent.handoffs[0].agentName : ""), team.reviewerAgent?.name);
});
