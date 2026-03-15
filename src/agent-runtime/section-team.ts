import { Agent, Handoff, handoff } from "@openai/agents";
import { removeAllTools } from "@openai/agents-core/extensions";
import type { Tool, ModelSettings } from "@openai/agents";

interface AgentRuntimeConfig {
  model: string;
  modelSettings: ModelSettings;
}

export interface SectionAgentTeamConfig {
  section: string;
  step: string;
  validateToolName: string;
  plannerRuntime: AgentRuntimeConfig;
  writerRuntime: AgentRuntimeConfig;
  reviewerRuntime?: AgentRuntimeConfig;
  repairerRuntime?: AgentRuntimeConfig;
  validateTool: Tool;
  writerInstructions: string;
  reviewerInstructions?: string;
  repairInstructions?: string;
}

export interface SectionAgentTeam {
  plannerAgent: Agent;
  writerAgent: Agent;
  reviewerAgent?: Agent;
  repairerAgent?: Agent;
}

function normalizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "section";
}

function buildAgentName(role: string, step: string): string {
  const normalizedRole = normalizeName(role).slice(0, 24) || "agent";
  const normalizedStep = normalizeName(step) || "step";
  return `${normalizedRole}_${normalizedStep}`;
}

function describeAllowedHandoffs(handoffs: Array<Agent | Handoff>): string {
  if (handoffs.length === 0) {
    return "当前没有任何 handoff 工具可用。不要调用任何 transfer_to_* 工具。";
  }
  const toolNames = handoffs.map((item) => item instanceof Handoff ? item.toolName : `transfer_to_${item.name}`);
  return `只允许调用当前可见的 handoff 工具: ${toolNames.join("、")}。不要臆造任何其它 transfer_to_* 工具名。`;
}

export function buildSectionAgentTeam(config: SectionAgentTeamConfig): SectionAgentTeam {
  const repairerAgent = config.repairInstructions
    ? new Agent({
        name: buildAgentName("repairer", config.step),
        instructions: [
          config.repairInstructions,
          "你没有任何 handoff 目标。",
          "不要调用任何 transfer_to_* 工具，也不要调用任何校验工具。",
          "你只负责根据失败原因重写完整终稿。",
          "收到修复要求后，必须直接输出修复后的完整终稿，不要解释。"
        ].join("\n"),
        handoffDescription: `修复 ${config.section} section 的专家`,
        model: config.repairerRuntime?.model ?? config.writerRuntime.model,
        modelSettings: config.repairerRuntime?.modelSettings ?? config.writerRuntime.modelSettings
      })
    : undefined;

  const reviewerAgent = config.reviewerInstructions
    ? new Agent({
        name: buildAgentName("reviewer", config.step),
        instructions: [
          config.reviewerInstructions,
          "你负责复核 writer 刚交来的候选稿。",
          "不要调用任何工具，也不要再 handoff 给其它 agent。",
          "若发现明显问题，直接把整稿修到更符合要求后再输出。",
          "直接输出最终稿，不要解释。"
        ].join("\n"),
        handoffDescription: `复核 ${config.section} section 的专家`,
        model: config.reviewerRuntime?.model ?? config.writerRuntime.model,
        modelSettings: config.reviewerRuntime?.modelSettings ?? config.writerRuntime.modelSettings
      })
    : undefined;

  const reviewerHandoff = reviewerAgent
    ? handoff(reviewerAgent, {
        inputFilter: removeAllTools
      })
    : undefined;

  const writerHandoffs = reviewerAgent
    ? [reviewerHandoff].filter((item): item is Handoff => !!item)
    : [];
  const writerAgent = new Agent({
    name: buildAgentName("writer", config.step),
    instructions: [
      config.writerInstructions,
      describeAllowedHandoffs(writerHandoffs),
      "不要调用任何工具。",
      "先完成完整候选稿。",
      reviewerAgent
        ? "若 reviewer 可用，完成候选稿后必须 handoff 给 reviewer。"
        : "若校验通过，只输出 final_output，不要解释。",
      reviewerAgent ? "writer 不允许直接结束任务。" : "若校验未通过，handoff 给 repairer。"
    ].join("\n"),
    handoffDescription: `生成 ${config.section} section 的专家`,
    model: config.writerRuntime.model,
    modelSettings: config.writerRuntime.modelSettings,
    handoffs: writerHandoffs
  });

  const plannerAgent = Agent.create({
    name: buildAgentName("section_planner", config.step),
    instructions: [
      `你负责协调 ${config.section} section 的生成。`,
      "立刻 handoff 给 writer specialist。",
      "不要自己输出正文。"
    ].join("\n"),
    model: config.plannerRuntime.model,
    modelSettings: config.plannerRuntime.modelSettings,
    handoffs: [writerAgent]
  });

  return {
    plannerAgent,
    writerAgent,
    reviewerAgent,
    repairerAgent
  };
}
