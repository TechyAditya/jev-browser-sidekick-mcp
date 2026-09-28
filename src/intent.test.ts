import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesActionLabel, parseIntent } from "./intent.js";

test("a search step carries only a query", () => {
  const intent = parseIntent("search aloo bhujia");
  assert.equal(intent.kind, "search");
  assert.equal(intent.query, "aloo bhujia");
  assert.deepEqual(intent.actionLabels, []);
});

test("a press step names one control", () => {
  const intent = parseIntent("click add to cart");
  assert.equal(intent.kind, "press");
  assert.deepEqual(intent.actionLabels, ["add to cart"]);
});

test("a pick step names the entry to open", () => {
  const intent = parseIntent("open the aloo bhujia product");
  assert.equal(intent.kind, "pick");
  assert.match(intent.subject, /aloo bhujia/);
});

test("a short open is a destination, not an entry", () => {
  const intent = parseIntent("open the cart page");
  assert.equal(intent.kind, "goto");
  assert.equal(intent.destination, "cart");
});

test("a step naming a result picks an entry, however short the subject", () => {
  // "best", "matching" and "result" are stop words, so a naive word count
  // reads this as a two-word destination and follows any matching link.
  for (const step of [
    "open the best matching colgate toothpaste result",
    "open the first coke result",
    "open the top result for aloo bhujia",
  ]) {
    const intent = parseIntent(step);
    assert.equal(intent.kind, "pick", step);
    assert.equal(intent.destination, undefined, step);
  }
});

test("a compound step still names its control and its subject", () => {
  const intent = parseIntent("add colgate toothpaste to cart");
  assert.equal(intent.kind, "press");
  assert.ok(intent.actionLabels.includes("add to cart"));
  assert.equal(intent.subject, "colgate toothpaste");
  assert.equal(intent.query, "colgate toothpaste");
});

test("an already-done clause comes off the label rather than steering the step", () => {
  // Left in, the clause becomes part of the label and matches no control.
  assert.deepEqual(parseIntent("click add to cart if not already added").actionLabels, [
    "add to cart",
  ]);
  assert.equal(parseIntent("add colgate to cart unless already in the cart").subject, "colgate");
  assert.deepEqual(parseIntent("click add to cart").actionLabels, ["add to cart"]);
});

test("a control named with the row it sits on keeps a short label", () => {
  // "Delete for the X item" as one label matches no button, so the press
  // never counts as done and the next look calls the page wrong.
  const intent = parseIntent("click Delete for the Coca-Cola Cherry item");
  assert.deepEqual(intent.actionLabels, ["Delete"]);
  assert.match(intent.subject, /Coca-Cola Cherry/);
  assert.equal(matchesActionLabel("Delete Coca-Cola Cherry Soft Drink", intent.actionLabels), true);
});

test("a read step asks for the page's words", () => {
  const intent = parseIntent("read the cart contents");
  assert.equal(intent.kind, "read");
  assert.deepEqual(intent.actionLabels, []);
  assert.equal(parseIntent("list the items in the cart").kind, "read");
});

test("repetition is the shape; clearing a cart is one use of it", () => {
  // The verb names the thing, so the control comes from the verb itself.
  const clear = parseIntent("clear cart");
  assert.equal(clear.kind, "loop");
  assert.deepEqual(clear.actionLabels, ["delete", "remove"]);
  assert.match(clear.loop?.until ?? "", /cart is empty/i);

  // A step that names its own control keeps it, on any kind of page.
  const more = parseIntent("keep clicking Load more");
  assert.equal(more.kind, "loop");
  assert.deepEqual(more.actionLabels, ["Load more"]);
  assert.equal(more.loop?.bodyTask, "click Load more");
  assert.match(more.loop?.until ?? "", /no longer offers a "Load more" control/);

  // "dismiss all" names the thing too, and Dismiss is the control for it.
  assert.deepEqual(parseIntent("dismiss all notifications").actionLabels, ["dismiss", "close"]);
});

test("a loop says its own condition, and the body is an ordinary step", () => {
  const loop = parseIntent("repeat click remove until the cart is empty");
  assert.equal(loop.kind, "loop");
  assert.equal(loop.loop?.bodyTask, "click remove");
  assert.equal(loop.loop?.until, "the cart is empty");
  assert.equal(loop.loop?.body.kind, "press");
  assert.deepEqual(loop.loop?.body.actionLabels, ["remove"]);

  // The condition splits on the last "until", so a body may contain the word.
  const nested = parseIntent("repeat click show more until no more rows appear");
  assert.equal(nested.loop?.bodyTask, "click show more");
  assert.equal(nested.loop?.until, "no more rows appear");

  // A caller who writes the condition wins over the derived one.
  assert.equal(
    parseIntent("keep clicking Load more until every review is shown").loop?.until,
    "every review is shown",
  );
});

test("the same shapes work away from shopping", () => {
  assert.equal(parseIntent("click subscribe").actionLabels[0], "subscribe");
  assert.equal(parseIntent("search quarterly report").query, "quarterly report");
  assert.equal(parseIntent("download the invoice").kind, "press");
});

test("labels match a control however it is written", () => {
  assert.equal(matchesActionLabel("Add to cart", ["add to cart"]), true);
  assert.equal(matchesActionLabel("Add to Cart, Colgate MaxFresh", ["add to cart"]), true);
  assert.equal(matchesActionLabel("Buy now", ["add to cart"]), false);
});

test("a word that merely starts with the label is not the control", () => {
  // Flipkart's footer sank a run: "address" contains "add".
  const labels = parseIntent("add colgate toothpaste to cart").actionLabels;
  assert.ok(labels.includes("add"));
  assert.equal(matchesActionLabel("Registered Office Address:", labels), false);
  assert.equal(matchesActionLabel("Additional information", labels), false);
  assert.equal(matchesActionLabel("Add to cart", labels), true);
});

test("prose that happens to contain the word is not the control", () => {
  const title =
    "Colgate Visible White Purple Toothpaste for Teeth Whitening, Helps Remove Surface Stains, Enamel-Safe";
  assert.equal(matchesActionLabel(title, ["remove", "delete"]), false);
  assert.equal(matchesActionLabel("Delete Bikano Aloo Bhujia 1kg", ["delete", "remove"]), true);
});
