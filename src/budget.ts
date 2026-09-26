/**
 * Jev 1.13 limits, from the model card:
 * 64k tokens for the state plus every question combined, and
 * 32k tokens for the state plus the single longest question.
 * https://docs.typesafe.ai/models
 */
export const MAX_REQUEST_TOKENS = 64_000;
export const MAX_STATE_PLUS_QUESTION_TOKENS = 32_000;

/** ~4 chars per token, plus JSON quoting overhead. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

export const estimateJsonTokens = (value: unknown): number =>
  estimateTokens(JSON.stringify(value ?? {}));

/** Both ceilings depend on the widest question, not the whole set. */
export const questionSizes = (
  questions: Record<string, unknown>,
): { total: number; longest: number } => {
  let total = 0;
  let longest = 0;
  for (const question of Object.values(questions ?? {})) {
    const size = estimateJsonTokens(question);
    total += size;
    if (size > longest) longest = size;
  }
  return { total, longest };
};

export interface BudgetPart {
  text: string;
  /** Keep even when the budget is tight. The current page is pinned. */
  pin?: boolean;
}

export interface ContextBudget {
  /** Element rows the next question may offer. Shrinks as the run gets long. */
  elementLimit(): number;
  /** Tokens the state may use beside these questions. */
  stateCap(questions: Record<string, unknown>): number;
  /** True when the request would breach either documented ceiling. */
  fits(state: string, questions: Record<string, unknown>): boolean;
  /** Drop unpinned parts oldest first until the state fits beside the questions. */
  fit(parts: BudgetPart[], questions: Record<string, unknown>): string;
  /** Record what the provider charged, so later steps get smaller. */
  record(inputTokens: number): void;
  spent(): number;
}

export const createContextBudget = (
  maxRequest: number = MAX_REQUEST_TOKENS,
  maxStatePlusQuestion: number = MAX_STATE_PLUS_QUESTION_TOKENS,
): ContextBudget => {
  let used = 0;

  const stateCap = (questions: Record<string, unknown>): number => {
    const { total, longest } = questionSizes(questions);
    // Whichever documented ceiling binds first wins.
    const byRequest = maxRequest - total;
    const byQuestion = maxStatePlusQuestion - longest;
    return Math.max(300, Math.min(byRequest, byQuestion));
  };

  return {
    stateCap,
    elementLimit() {
      // A long run means a long page history; keep the option list readable.
      if (used < 60_000) return 36;
      if (used < 150_000) return 24;
      return 16;
    },
    fits(state, questions) {
      const { total, longest } = questionSizes(questions);
      const stateTokens = estimateTokens(state);
      return (
        stateTokens + total <= maxRequest && stateTokens + longest <= maxStatePlusQuestion
      );
    },
    fit(parts, questions) {
      const cap = stateCap(questions);
      const kept = [...parts];
      const render = (rows: BudgetPart[]): string =>
        rows
          .map((row) => row.text)
          .filter(Boolean)
          .join("\n");

      // Forget old pages first. The pinned live page stays.
      for (let index = 0; index < kept.length && estimateTokens(render(kept)) > cap; index += 1) {
        if (kept[index]?.pin) continue;
        kept[index] = { text: "" };
      }

      const text = render(kept);
      if (estimateTokens(text) <= cap) return text;
      return text.slice(0, Math.max(300, Math.floor(cap * 3.6)));
    },
    record(inputTokens) {
      used += Math.max(0, inputTokens);
    },
    spent() {
      return used;
    },
  };
};
