import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDecisionBody } from "./jev.js";

test("HTML or empty TypeSafe bodies are rejected", () => {
  assert.throws(
    () => parseDecisionBody("<!DOCTYPE html><html>Proceed with caution</html>", 1),
    /HTML/,
  );
  assert.throws(() => parseDecisionBody("not json at all", 1), /non-JSON/);
  assert.throws(() => parseDecisionBody(null, 1), /non-object/);
  assert.throws(() => parseDecisionBody({ usage: {} }, 1), /missing answers/);
  assert.throws(() => parseDecisionBody({ answers: {} }, 2), /empty answers/);
});

test("a real decision body keeps its answers and usage", () => {
  const parsed = parseDecisionBody(
    {
      answers: {
        operation: {
          type: "choice",
          choice: "CLICK",
          probabilities: { CLICK: 0.9 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 12, output_tokens: 3 },
      model: "jev-1.13",
    },
    1,
  );
  assert.equal(parsed.answers.operation?.type, "choice");
  assert.equal(parsed.usage.inputTokens, 12);
  assert.equal(parsed.usage.outputTokens, 3);
  assert.equal(parsed.model, "jev-1.13");
});
