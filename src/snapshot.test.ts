import assert from "node:assert/strict";
import { test } from "node:test";
import { hostOf, parseTabList } from "./playwright.js";
import {
  describeElement,
  isTypable,
  looksLikeAdd,
  nearestTitle,
  pageShows,
  parseSnapshot,
  proofContext,
  secretDemand,
  type PageElement,
} from "./snapshot.js";

test("parses playwright accessibility lines", () => {
  const raw = `
- Page URL: https://www.amazon.in/
- Page Title: Amazon.in
- textbox "Search Amazon.in" [ref=e3]
- button "Go" [ref=e4]
- link "Colgate toothpaste" [ref=e12]: "in cart"
`;
  const parsed = parseSnapshot(raw);
  assert.equal(parsed.url, "https://www.amazon.in/");
  assert.equal(parsed.title, "Amazon.in");
  assert.equal(parsed.elements.length, 3);
  assert.equal(parsed.elements[0]?.ref, "e3");
  assert.ok(isTypable(parsed.elements[0]!));
  assert.equal(parsed.elements[2]?.name, "Colgate toothpaste");
});

test("labels add-to-cart for a chooser", () => {
  assert.equal(looksLikeAdd("Add to cart"), true);
  assert.match(describeElement({ ref: "e1", role: "button", name: "Add to cart" }), /^ADD /);
});

test("a secret field or a human check hands the page back", () => {
  assert.equal(
    secretDemand([{ ref: "e1", role: "textbox", name: "Password" }]),
    "credentials",
  );
  assert.equal(
    secretDemand([{ ref: "e2", role: "textbox", name: "Enter the OTP sent to your phone" }]),
    "credentials",
  );
  assert.equal(
    secretDemand([{ ref: "e3", role: "checkbox", name: "I'm not a robot" }]),
    "captcha",
  );
  // A link about passwords is not a field asking for one.
  assert.equal(secretDemand([{ ref: "e4", role: "link", name: "Forgot password?" }]), undefined);
  assert.equal(secretDemand([{ ref: "e5", role: "textbox", name: "Search" }]), undefined);
});

test("proof text ignores case and spacing", () => {
  assert.equal(pageShows('- text "Subtotal (3 items)"', "subtotal (3 items)"), true);
  assert.equal(pageShows("- text  \"Cart\n  is   empty\"", "cart is empty"), true);
  assert.equal(pageShows("- text \"Subtotal (2 items)\"", "subtotal (3 items)"), false);
  assert.equal(pageShows("anything", ""), false);
});

test("a control is described by the title it sits under", () => {
  // A product page carries its own Add button and one per recommendation
  // tile, all named the same. The neighbouring title is the only difference.
  const page: PageElement[] = [
    { ref: "e1", role: "link", name: "Coca Cola Soft Drink - Diet Coke, 330ml Can" },
    { ref: "e2", role: "button", name: "Add to cart" },
    { ref: "e3", role: "link", name: "SOBER Whiskey Alternative | 0.0% ABV Zero Alcohol Drink" },
    { ref: "e4", role: "button", name: "Add to cart" },
  ];
  assert.match(nearestTitle(page, page[1]!) ?? "", /Diet Coke/);
  assert.match(nearestTitle(page, page[3]!) ?? "", /SOBER Whiskey/);
  assert.equal(nearestTitle(page, page[0]!), undefined);
});

test("a tab list keeps each tab's address", () => {
  const text = `**2 tab(s)** total

[0] **targetId: AAAA1111BBBB2222** [jev-a1]
    Amazon.in Shopping Cart
    https://www.amazon.in/gp/cart/view.html

[1] **targetId: CCCC3333DDDD4444** [jev-b2]
    Flipkart
    https://www.flipkart.com/viewcart`;
  const rows = parseTabList(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.targetId, "AAAA1111BBBB2222");
  assert.equal(hostOf(rows[0]?.url ?? ""), "amazon.in");
  assert.equal(hostOf(rows[1]?.url ?? ""), "flipkart.com");
});

test("proof carries its neighbours, so a rail cannot pass as a cart line", () => {
  const empty =
    "Your Amazon Cart is empty. Customers who bought items in your cart also bought Colgate MaxFresh";
  const found = proofContext(empty, "Colgate");
  // The words are there, and the context is what shows they prove nothing.
  assert.ok(found);
  assert.match(found, /also bought Colgate/);
  assert.equal(proofContext(empty, "Sensodyne"), undefined);
});
