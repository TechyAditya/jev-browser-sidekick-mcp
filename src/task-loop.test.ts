import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { isEndpointReason } from "./endpoint.js";
import { runAction } from "./loop.js";
import type { RunActionResult } from "./types.js";

/**
 * A provider that is down says nothing about these features, so the test
 * steps aside rather than reporting the loop broken.
 */
const skipOnOutage = (t: TestContext, result: RunActionResult): boolean => {
  const fault = result.groups
    ?.flatMap((group) => group.tasks)
    .find((task) => isEndpointReason(task.reason));
  if (!fault) return false;
  t.skip(`provider fault: ${fault.summary}`);
  return true;
};

/**
 * These drive a real page and ask Jev real questions, so they need the shared
 * Chrome and a key. CI has neither. Set JEV_E2E=1 to run them anyway.
 */
const browserReady = async (): Promise<boolean> => {
  if (process.env.JEV_E2E === "1") return true;
  const config = loadConfig();
  if (!config.apiKey) return false;
  const cdp = config.playwright.cdpEndpoint;
  if (!cdp) return false;
  try {
    const response = await fetch(new URL("/json/version", cdp), {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const skip = (await browserReady())
  ? false
  : "no browser on the CDP endpoint, or no API key. Set JEV_E2E=1 to force";

const serve = async (html: string): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listen address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((done, fail) => {
        // The tab holds a keep-alive socket, and close() waits for it.
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
};

/** A cart whose rows leave over the network, the way a real site deletes them. */
const CART = `<!doctype html><html><head><title>Loop fixture cart</title></head><body>
<h1>Your cart</h1>
<ul id="rows">
  <li>Colgate toothpaste <button class="remove">Remove</button></li>
  <li>Tata salt <button class="remove">Remove</button></li>
  <li>Amul butter <button class="remove">Remove</button></li>
</ul>
<p id="status">3 items in the cart</p>
<script>
document.addEventListener("click", function (event) {
  var button = event.target.closest("button.remove");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Removing";
  setTimeout(function () {
    button.closest("li").remove();
    var left = document.querySelectorAll("#rows li").length;
    document.getElementById("status").textContent =
      left ? left + " items in the cart" : "Your cart is empty";
  }, 400);
});
</script></body></html>`;

/** A button that answers every press by doing nothing at all. */
const INERT = `<!doctype html><html><head><title>Loop fixture inert</title></head><body>
<h1>Nothing happens here</h1>
<button id="ping">Ping</button>
<p>This page never finishes anything.</p>
</body></html>`;

/**
 * A news list whose story titles carry the words a challenge uses. Hacker
 * News ran exactly this and the whole series came back blocked as a captcha.
 */
const PROSE = `<!doctype html><html><head><title>Fixture news</title></head><body>
<h1>Today's stories</h1>
<ol>
  <li><a href="#s1">Solving a corn puzzle with CP-SAT</a></li>
  <li><a href="#s2">The captcha industry is worth billions</a></li>
  <li><a href="#s3">Why the robot check will not save you</a></li>
</ol>
<button id="more">More</button>
</body></html>`;

/** A product already in the cart: the Add control is gone, the outcome is shown. */
const ADDED = `<!doctype html><html><head><title>Colgate toothpaste</title></head><body>
<h1>Colgate toothpaste</h1>
<p>In your cart: 1</p>
<button id="go">Go to cart</button>
</body></html>`;

test("a loop presses until the page says it is empty", { timeout: 150_000, skip }, async (t) => {
  const page = await serve(CART);
  try {
    const result = await runAction({
      groups: [
        {
          id: "cart",
          startUrl: page.url,
          tasks: [
            {
              loop: {
                tasks: ["click remove"],
                until: "the page says Your cart is empty and no Remove button is left",
                maxRounds: 8,
              },
            },
          ],
          expect: "Your cart is empty",
        },
      ],
      timeoutMs: 90_000,
      debug: true,
    });

    if (skipOnOutage(t, result)) return;
    const group = result.groups?.[0];
    assert.ok(group, "group result");
    const loop = group.tasks[0];
    assert.equal(loop?.status, "completed", loop?.summary);
    // Three rows, so three presses at best. A round whose press lands on a
    // ref the page just deleted buys another one, which is why loops exist.
    const rounds = loop?.rounds ?? 0;
    assert.ok(rounds >= 3 && rounds <= 6, `took ${rounds} rounds`);
    assert.equal(group.verified, true);
  } finally {
    await page.close();
  }
});

test("a loop that changes nothing stops at its ceiling", { timeout: 150_000, skip }, async (t) => {
  const page = await serve(INERT);
  try {
    const result = await runAction({
      groups: [
        {
          id: "inert",
          startUrl: page.url,
          tasks: [
            {
              loop: {
                tasks: ["click ping"],
                until: "the page says All done",
                maxRounds: 3,
              },
            },
          ],
        },
      ],
      timeoutMs: 90_000,
      debug: true,
    });

    if (skipOnOutage(t, result)) return;
    const loop = result.groups?.[0]?.tasks[0];
    assert.ok(loop, "loop result");
    assert.notEqual(loop.status, "completed");
    assert.ok((loop.rounds ?? 0) <= 3, `rounds ${loop.rounds} above the ceiling`);
    assert.match(loop.summary, /round/i);
  } finally {
    await page.close();
  }
});

test("words in a story title are not a challenge", { timeout: 150_000, skip }, async (t) => {
  const page = await serve(PROSE);
  try {
    const result = await runAction({
      groups: [{ id: "prose", startUrl: page.url, tasks: ["click More"] }],
      timeoutMs: 90_000,
      debug: true,
    });

    if (skipOnOutage(t, result)) return;
    const step = result.groups?.[0]?.tasks[0];
    assert.ok(step, "step result");
    // The harness still raises the suspicion. Jev reads the page and says no,
    // so the step goes on to press the control instead of handing back.
    assert.notEqual(step.reason, "captcha");
    assert.equal(step.status, "completed", step.summary);
  } finally {
    await page.close();
  }
});

test("an outcome already on the page is already_done, and the series carries on", { timeout: 150_000, skip }, async (t) => {
  const page = await serve(ADDED);
  try {
    const result = await runAction({
      groups: [
        {
          id: "added",
          startUrl: page.url,
          tasks: ["click add to cart", "read the page title and url"],
        },
      ],
      timeoutMs: 90_000,
      debug: true,
    });

    if (skipOnOutage(t, result)) return;
    const group = result.groups?.[0];
    assert.ok(group, "group result");
    assert.equal(group.tasks[0]?.status, "rejected");
    assert.equal(group.tasks[0]?.reason, "already_done");
    // The ground the next step stands on is there, so the series kept going.
    assert.equal(group.tasks[1]?.status, "completed");
    assert.match(group.tasks[1]?.summary ?? "", /Colgate toothpaste/i);
  } finally {
    await page.close();
  }
});
