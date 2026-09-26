import { choiceOf, type Answer } from "./jev.js";
import type { JevConfig } from "./types.js";
import type { Operation } from "./questions.js";

export type Verdict =
  | { kind: "finish"; reason: string }
  | { kind: "blocked"; reason: string }
  | {
      kind: "act";
      operation: Operation;
      target?: string;
      valueId?: string;
      submit?: boolean;
      /** How long a WAIT should last. */
      waitMs?: number;
      confidence?: number;
    };

export const compose = (
  answers: Record<string, Answer>,
  config: JevConfig,
  ctx: { step: number; maxSteps: number; consecutiveWaits: number; repeats: number },
): Verdict => {
  const operation = choiceOf(answers, "operation");
  const pick = operation?.choice as Operation | undefined;

  if (ctx.step >= ctx.maxSteps) {
    return { kind: "blocked", reason: "hard step limit" };
  }
  if (ctx.repeats >= 3 && pick !== "WAIT") {
    return { kind: "blocked", reason: "same action repeated three times" };
  }
  if (pick === "WAIT" && ctx.consecutiveWaits >= 3) {
    return { kind: "blocked", reason: "stuck waiting" };
  }
  if (!pick) {
    return { kind: "blocked", reason: "no operation returned" };
  }
  if ((operation?.confidence ?? 1) < config.thresholds.minConfidence) {
    if (ctx.consecutiveWaits < 2) {
      return { kind: "act", operation: "WAIT", confidence: operation?.confidence };
    }
    return { kind: "blocked", reason: "low-confidence operation after waits" };
  }

  const targetFor = (op: Operation): string | undefined => {
    if (op === "CLICK") return choiceOf(answers, "click_target")?.choice;
    if (op === "TYPE_TEXT") return choiceOf(answers, "type_target")?.choice;
    if (op === "SELECT") return choiceOf(answers, "select_target")?.choice;
    if (op === "NAVIGATE") return choiceOf(answers, "navigate_target")?.choice;
    if (op === "READ_FILE") return choiceOf(answers, "file_target")?.choice;
    return undefined;
  };

  const seconds = Number(choiceOf(answers, "wait_seconds")?.choice);

  return {
    kind: "act",
    operation: pick,
    target: targetFor(pick),
    valueId: choiceOf(answers, "type_value")?.choice,
    submit: true,
    waitMs: Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 15) * 1000 : undefined,
    confidence: operation?.confidence,
  };
};
