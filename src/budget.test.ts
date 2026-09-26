import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_REQUEST_TOKENS,
  MAX_STATE_PLUS_QUESTION_TOKENS,
  createContextBudget,
  estimateTokens,
  questionSizes,
} from "./budget.js";

test("uses the documented Jev 1.13 ceilings", () => {
  assert.equal(MAX_REQUEST_TOKENS, 64_000);
  assert.equal(MAX_STATE_PLUS_QUESTION_TOKENS, 32_000);
});

test("sizes questions by total and by longest", () => {
  const sizes = questionSizes({ a: { instructions: "x".repeat(3600) }, b: { instructions: "y" } });
  assert.ok(sizes.longest >= 1000);
  assert.ok(sizes.total > sizes.longest);
});

test("drops old pages and keeps the live page", () => {
  const budget = createContextBudget(4000, 2000);
  const old = "old page ".repeat(4000);
  const live = "live page table";
  const state = budget.fit([{ text: old }, { text: old }, { text: live, pin: true }], {});
  assert.ok(state.includes(live));
  assert.ok(!state.includes("old page"));
});

test("the longest question, not the whole set, caps the state", () => {
  const budget = createContextBudget();
  const wide = budget.stateCap({ a: { instructions: "x".repeat(36_000) } });
  const many = budget.stateCap({ a: { instructions: "x" }, b: { instructions: "x" } });
  assert.ok(wide < many);
});

test("rejects a request that breaches a ceiling", () => {
  const budget = createContextBudget(1000, 1000);
  assert.equal(budget.fits("short", { a: { instructions: "x" } }), true);
  assert.equal(budget.fits("x".repeat(40_000), { a: { instructions: "x" } }), false);
});

test("shrinks the option list on very long runs", () => {
  const budget = createContextBudget();
  assert.equal(budget.elementLimit(), 36);
  budget.record(200_000);
  assert.ok(budget.elementLimit() < 36);
  assert.ok(estimateTokens("abcd") >= 1);
});
