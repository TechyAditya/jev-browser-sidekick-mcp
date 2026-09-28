import assert from "node:assert/strict";
import { test } from "node:test";
import { compose } from "./compose.js";
import type { Answer } from "./jev.js";
import type { JevConfig } from "./types.js";

const config = {
  thresholds: { complete: 0.85, looping: 0.7, blocked: 0.75, minConfidence: 0.32 },
} as JevConfig;

const ctx = { step: 1, maxSteps: 8, consecutiveWaits: 0, repeats: 0 };

const answers = (rows: Record<string, Answer>): Record<string, Answer> => rows;

test("a slow page gets the wait Jev asked for", () => {
  const verdict = compose(
    answers({
      operation: { type: "choice", choice: "WAIT", probabilities: {}, confidence: 0.9 },
      wait_seconds: { type: "choice", choice: "10", probabilities: {}, confidence: 0.8 },
    }),
    config,
    ctx,
  );
  assert.equal(verdict.kind, "act");
  assert.equal(verdict.kind === "act" && verdict.waitMs, 10_000);
});

test("a wait length is capped, never unbounded", () => {
  const verdict = compose(
    answers({
      operation: { type: "choice", choice: "WAIT", probabilities: {}, confidence: 0.9 },
      wait_seconds: { type: "choice", choice: "600", probabilities: {}, confidence: 0.8 },
    }),
    config,
    ctx,
  );
  assert.equal(verdict.kind === "act" && verdict.waitMs, 15_000);
});

test("missing operation is blocked for the caller to reclassify", () => {
  const verdict = compose(answers({}), config, ctx);
  assert.equal(verdict.kind, "blocked");
  assert.equal(verdict.kind === "blocked" && verdict.reason, "no operation returned");
});
