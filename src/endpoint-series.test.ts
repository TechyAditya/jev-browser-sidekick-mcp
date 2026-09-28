import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { runAction } from "./loop.js";
import type { JevConfig } from "./types.js";

const listen = (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; setHandler: (next: typeof handler) => void }> =>
  new Promise((resolve, reject) => {
    let current = handler;
    const server = createServer((req, res) => current(req, res));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no listen address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        setHandler: (next) => {
          current = next;
        },
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });

const failWith = (status: number, body: string, contentType = "application/json") => {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  };
};

test("a two-step series stops on rate_limit, stays resumable, and resume skips completed work", { timeout: 90_000 }, async () => {
  const stub = await listen(failWith(429, '{"error":"rate limit exceeded"}'));
  const base = loadConfig();
  const config = {
    ...base,
    provider: "official",
    apiKey: base.apiKey || "test-key",
    baseUrl: stub.url,
    callTimeoutMs: 8_000,
    taskTimeoutMs: 30_000,
    runTimeoutMs: 60_000,
  } as JevConfig;

  try {
    const first = await runAction(
      {
        groups: [
          {
            id: "series",
            startUrl: "https://en.wikipedia.org/wiki/Kolmogorov_complexity",
            tasks: [
              "read the page title and url",
              "open the Kolmogorov complexity result",
              "read the page title and url",
            ],
          },
        ],
        timeoutMs: 60_000,
        debug: true,
      },
      config,
    );

    const group = first.groups?.[0];
    assert.ok(group, "group result");
    assert.equal(group.tasks[0]?.status, "completed");
    assert.equal(group.tasks[1]?.status, "error");
    assert.equal(group.tasks[1]?.reason, "rate_limit");
    assert.match(group.tasks[1]?.summary ?? "", /HTTP 429|rate_limit/);
    assert.equal(group.tasks[2]?.status, "skipped");
    assert.equal(group.handoff?.resumable, true);
    assert.ok(group.handoff?.targetId);
    assert.deepEqual(group.handoff?.remaining, ["read the page title and url"]);
    assert.equal(first.usage?.decisions ?? 0, 0);

    // Resume only the remaining step. The stub still fails decides; a read needs none.
    stub.setHandler(failWith(503, '{"error":"still down"}'));
    const second = await runAction(
      {
        groups: [
          {
            id: "resume",
            targetId: group.handoff!.targetId,
            groupId: group.handoff!.groupId,
            tasks: group.handoff!.remaining,
          },
        ],
        timeoutMs: 30_000,
        debug: true,
      },
      config,
    );
    const resumed = second.groups?.[0];
    assert.ok(resumed);
    assert.equal(resumed.tasks.length, 1);
    assert.equal(resumed.tasks[0]?.status, "completed");
    assert.match(resumed.tasks[0]?.summary ?? "", /Kolmogorov complexity/i);
    assert.equal(resumed.tasks[0]?.goal, "read the page title and url");
  } finally {
    await stub.close();
  }
});

test("proxy interstitial is blocked, not a page reject, and resumable", { timeout: 90_000 }, async () => {
  const stub = await listen(
    failWith(200, "<!DOCTYPE html><html>Proceed with caution</html>", "text/html"),
  );
  const base = loadConfig();
  const config = {
    ...base,
    provider: "official",
    apiKey: base.apiKey || "test-key",
    baseUrl: stub.url,
    callTimeoutMs: 8_000,
  } as JevConfig;

  try {
    const result = await runAction(
      {
        groups: [
          {
            id: "proxy",
            startUrl: "https://en.wikipedia.org/wiki/Kolmogorov_complexity",
            tasks: ["open the Kolmogorov complexity result", "read the page title and url"],
          },
        ],
        timeoutMs: 60_000,
        debug: true,
      },
      config,
    );
    const group = result.groups?.[0];
    assert.ok(group);
    assert.equal(group.tasks[0]?.status, "blocked");
    assert.equal(group.tasks[0]?.reason, "proxy_interstitial");
    assert.match(group.tasks[0]?.summary ?? "", /proxy_interstitial|HTTP 200/);
    assert.equal(group.tasks[1]?.status, "skipped");
    assert.equal(group.handoff?.resumable, true);
    assert.equal(result.usage?.decisions ?? 0, 0);
  } finally {
    await stub.close();
  }
});
