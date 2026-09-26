import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterByTab, resolveGroups } from "./plan.js";

test("a lone goal stays one task; parent must write the series", () => {
  const goal =
    "Open amazon.in, add colgate toothpaste, aloo bhujia, redbull 6 pc to cart, bring them to checkout page";
  const groups = resolveGroups({ goal, targetId: "TAB1" });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.targetId, "TAB1");
  assert.deepEqual(groups[0]?.tasks, [goal]);
});

test("parent tasks stay a series on one tab", () => {
  const groups = resolveGroups({
    targetId: "TAB1",
    tasks: ["add paste", "add redbull", "open checkout"],
  });
  assert.deepEqual(groups[0]?.tasks, ["add paste", "add redbull", "open checkout"]);
});

test("parent groups run as written", () => {
  const groups = resolveGroups({
    groups: [
      { id: "shop", targetId: "A", tasks: ["add paste", "add redbull", "open checkout"] },
      { id: "other", targetId: "B", goal: "open example.com" },
    ],
  });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.tasks, ["add paste", "add redbull", "open checkout"]);
  assert.deepEqual(groups[1]?.tasks, ["open example.com"]);
});

test("a series stops at a failed step unless noFail is set", () => {
  assert.equal(resolveGroups({ tasks: ["one", "two"] })[0]?.noFail, false);
  assert.equal(resolveGroups({ tasks: ["one", "two"], noFail: true })[0]?.noFail, true);
  const groups = resolveGroups({
    noFail: true,
    groups: [{ id: "strict", tasks: ["one"], noFail: false }, { id: "loose", tasks: ["two"] }],
  });
  assert.equal(groups[0]?.noFail, false);
  assert.equal(groups[1]?.noFail, true);
});

test("proof text follows the series it belongs to", () => {
  assert.equal(resolveGroups({ tasks: ["one"], expect: "3 items" })[0]?.expect, "3 items");
  const groups = resolveGroups({
    expect: "top level",
    groups: [{ id: "own", tasks: ["one"], expect: "in cart" }, { id: "none", tasks: ["two"] }],
  });
  assert.equal(groups[0]?.expect, "in cart");
  // A top-level proof does not silently apply to every parallel series.
  assert.equal(groups[1]?.expect, undefined);
});

test("same targetId stays serial; different ids go parallel", () => {
  const clusters = clusterByTab([
    { id: "g1", targetId: "A", tasks: ["one"], noFail: false },
    { id: "g2", targetId: "A", tasks: ["two"], noFail: false },
    { id: "g3", targetId: "B", tasks: ["three"], noFail: false },
  ]);
  assert.equal(clusters.length, 2);
  const shared = clusters.find((row) => row[0]?.targetId === "A");
  assert.equal(shared?.length, 2);
});
