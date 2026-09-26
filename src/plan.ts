import { resolveTasks } from "./extract.js";
import type { RunActionInput, TaskGroupSpec } from "./types.js";

export interface PlannedGroup {
  id: string;
  targetId?: string;
  groupId?: string;
  startUrl?: string;
  goal?: string;
  tasks: string[];
  /** Keep going after a step that did not complete. */
  noFail: boolean;
  /** Text that proves this series worked. Checked on the final page. */
  expect?: string;
}

export const resolveGroups = (input: RunActionInput): PlannedGroup[] => {
  if (input.groups?.length) {
    return input.groups.slice(0, 4).map((spec, index) => planOne(spec, input, index));
  }
  return [
    planOne(
      {
        id: "g1",
        targetId: input.targetId,
        groupId: input.groupId,
        startUrl: input.startUrl,
        goal: input.goal,
        tasks: input.tasks,
        noFail: input.noFail,
        expect: input.expect,
      },
      input,
      0,
    ),
  ];
};

const planOne = (spec: TaskGroupSpec, input: RunActionInput, index: number): PlannedGroup => {
  const tasks = resolveTasks(spec.tasks, spec.goal);
  return {
    id: spec.id?.trim() || `g${index + 1}`,
    targetId: spec.targetId ?? (input.groups?.length ? undefined : input.targetId),
    groupId: spec.groupId ?? input.groupId,
    startUrl: spec.startUrl ?? input.startUrl,
    goal: spec.goal ?? input.goal,
    tasks,
    noFail: spec.noFail ?? input.noFail ?? false,
    expect: spec.expect ?? (input.groups?.length ? undefined : input.expect),
  };
};

export const clusterByTab = (groups: PlannedGroup[]): PlannedGroup[][] => {
  const buckets = new Map<string, PlannedGroup[]>();
  for (const group of groups) {
    const key = group.targetId ?? `new:${group.id}`;
    const list = buckets.get(key) ?? [];
    list.push(group);
    buckets.set(key, list);
  }
  return [...buckets.values()];
};
