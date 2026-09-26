import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cartUrlFor,
  extractItems,
  extractUrls,
  extractValueCandidates,
  isAddTask,
  isCheckoutTask,
  resolveTasks,
} from "./extract.js";

test("extracts shopping urls and items", () => {
  const goal =
    "Open amazon.in, add colgate toothpaste, aloo bhujia, redbull 6 pc to cart, bring them to checkout page";
  assert.deepEqual(extractUrls(goal), ["https://amazon.in"]);
  assert.deepEqual(extractItems(goal), [
    "colgate toothpaste",
    "aloo bhujia",
    "redbull 6 pc",
  ]);
  assert.equal(extractValueCandidates(goal).length, 3);
});

test("does not invent tasks from a vague goal", () => {
  const goal =
    "Open amazon.in, add colgate toothpaste, aloo bhujia, redbull 6 pc to cart, bring them to checkout page";
  assert.deepEqual(resolveTasks(undefined, goal), [goal]);
});

test("classifies parent add and checkout tasks", () => {
  assert.equal(isAddTask("add colgate toothpaste to cart"), true);
  assert.equal(isCheckoutTask("open checkout"), true);
  assert.equal(isCheckoutTask("add paste to cart"), false);
  assert.equal(cartUrlFor("https://www.amazon.in/s?k=x"), "https://www.amazon.in/gp/cart/view.html");
});

test("uses parent tasks as given", () => {
  assert.deepEqual(resolveTasks(["add paste", "add redbull", "open checkout"], "ignored"), [
    "add paste",
    "add redbull",
    "open checkout",
  ]);
});

test("keeps an explicit start url", () => {
  assert.deepEqual(extractUrls("search flights", "https://www.google.com/travel/flights"), [
    "https://www.google.com/travel/flights",
  ]);
});
