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
          `${config.validateToolName} 是校验工具，不是 agent，也不是 handoff。`,
          "你没有任何 handoff 目标。",
          "绝不要调用任何 transfer_to_validator_* 工具。",
          "不要调用任何 transfer_to_* 工具；校验通过后直接输出 final_output 文本。",
          `若 ${config.validateToolName} 返回 repair_guidance，必须优先逐条执行其中的修复指令。`,
          `必须先根据上下文重写内容，再调用 ${config.validateToolName}。`,
          `若 ${config.validateToolName} 返回 errors，必须逐条消除这些错误后再继续。`,
          "若校验通过，只输出 final_output，不要解释。",
          "若校验未通过，可继续重写并再次调用工具。"
        ].join("\n"),
        handoffDescription: `修复 ${config.section} section 的专家`,
        model: config.repairerRuntime?.model ?? config.writerRuntime.model,
        modelSettings: config.repairerRuntime?.modelSettings ?? config.writerRuntime.modelSettings,
        tools: [config.validateTool]
      })
    : undefined;

  const repairerHandoff = repairerAgent
    ? handoff(repairerAgent, {
        inputFilter: removeAllTools
      })
    : undefined;

  const reviewerAgent = config.reviewerInstructions
    ? new Agent({
        name: buildAgentName("reviewer", config.step),
        instructions: [
          config.reviewerInstructions,
          `${config.validateToolName} 是校验工具，不是 agent，也不是 handoff。`,
          repairerHandoff ? describeAllowedHandoffs([repairerHandoff]) : describeAllowedHandoffs([]),
          "绝不要调用任何 transfer_to_validator_* 工具。",
          `必须调用 ${config.validateToolName} 复核最近的候选内容。`,
          "若返回 errors 或 repair_guidance，先基于这些结果判断哪些条目要修，避免无关改写。",
          "若校验通过，只输出 final_output，不要解释。",
          "若校验未通过，立刻 handoff 给 repairer。"
        ].join("\n"),
        handoffDescription: `复核 ${config.section} section 的专家`,
        model: config.reviewerRuntime?.model ?? config.writerRuntime.model,
        modelSettings: config.reviewerRuntime?.modelSettings ?? config.writerRuntime.modelSettings,
        tools: [config.validateTool],
        handoffs: repairerHandoff ? [repairerHandoff] : undefined
      })
    : undefined;

  const writerHandoffs = [reviewerAgent, repairerHandoff].filter((item): item is Agent | Handoff => !!item);
  const writerAgent = new Agent({
    name: buildAgentName("writer", config.step),
    instructions: [
      config.writerInstructions,
      `${config.validateToolName} 是校验工具，不是 agent，也不是 handoff。`,
      describeAllowedHandoffs(writerHandoffs),
      "绝不要调用任何 transfer_to_validator_* 工具。",
      `先生成候选内容，再调用 ${config.validateToolName}。`,
      "若返回 errors 或 repair_guidance，优先按 repair_guidance 调整，不要盲目整体改写。",
      "若校验通过，只输出 final_output，不要解释。",
      "若校验未通过且 reviewer 可用，handoff 给 reviewer；否则 handoff 给 repairer。"
    ].join("\n"),
    handoffDescription: `生成 ${config.section} section 的专家`,
    model: config.writerRuntime.model,
    modelSettings: config.writerRuntime.modelSettings,
    tools: [config.validateTool],
    handoffs: writerHandoffs
  });

  const plannerAgent = Agent.create({
    name: buildAgentName("section_planner", config.step),
    instructions: [
      `你负责协调 ${config.section} section 的生成。`,
      "立刻 handoff 给 writer specialist。",
      `${config.validateToolName} 是校验工具，不是 agent，也不是 handoff。`,
      "只在最终内容已经通过校验工具后才允许结束。"
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
