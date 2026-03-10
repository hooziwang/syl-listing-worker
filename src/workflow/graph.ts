import type { WorkflowGraph, WorkflowNode, WorkflowSpec } from "./types.js";

function normalizeDeps(node: WorkflowNode): string[] {
  return Array.isArray(node.depends_on)
    ? node.depends_on.map((item) => item.trim()).filter(Boolean)
    : [];
}

export function buildWorkflowGraph(spec: WorkflowSpec): WorkflowGraph {
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    throw new Error("workflow nodes required");
  }

  const nodes = new Map<string, WorkflowNode>();
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of spec.nodes) {
    const id = node.id.trim();
    if (!id) {
      throw new Error("workflow node id required");
    }
    if (nodes.has(id)) {
      throw new Error(`workflow node duplicated: ${id}`);
    }
    nodes.set(id, node);
    indegree.set(id, 0);
    outgoing.set(id, []);
  }

  for (const node of spec.nodes) {
    const id = node.id.trim();
    for (const dep of normalizeDeps(node)) {
      if (!nodes.has(dep)) {
        throw new Error(`workflow dependency missing: ${id} -> ${dep}`);
      }
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      outgoing.get(dep)?.push(id);
    }
  }

  const ready: string[] = [];
  for (const [id, degree] of indegree.entries()) {
    if (degree === 0) {
      ready.push(id);
    }
  }
  ready.sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) {
      break;
    }
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  if (order.length !== spec.nodes.length) {
    throw new Error("workflow cycle detected");
  }

  return {
    spec,
    order,
    nodes
  };
}
