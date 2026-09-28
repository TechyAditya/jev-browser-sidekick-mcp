import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableOperations,
  buildActionSpace,
  buildQuestions,
  NO_CONTROL,
} from "./questions.js";
import type { PageElement } from "./snapshot.js";

test("click targets always offer a standing none option", () => {
  const page: PageElement[] = [
    { ref: "e1", role: "link", name: "Kolmogorov complexity article overview page" },
    { ref: "e2", role: "link", name: "An Introduction to Kolmogorov Complexity book" },
  ];
  const space = buildActionSpace(page, { urls: [], values: [], files: [], findTerms: [] });
  const ops = availableOperations(space, false, undefined, { clickOnly: true });
  const questions = buildQuestions(space, ops, "open the Kolmogorov complexity result", page, {
    pick: true,
  });
  assert.ok(questions.click_target);
  const criteria = (questions.click_target?.criteria ?? {}) as Record<string, string>;
  assert.match(criteria[NO_CONTROL] ?? "", /not a list of results/);
  assert.match(questions.click_target?.instructions as string, /page_title/);
  assert.match(criteria.e1 ?? "", /Kolmogorov complexity/);
});
