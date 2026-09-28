import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { classifyProviderError, EndpointError, isEndpointReason } from "./endpoint.js";
import { createJevClient, parseDecisionBody } from "./jev.js";
import { noTrace } from "./trace.js";
import type { JevConfig } from "./types.js";

const questions = {
  pick: {
    type: "choice" as const,
    instructions: "Pick one.",
    criteria: { a: "A", b: "B" },
  },
};

const listen = (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no listen address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });

const configFor = (baseUrl: string): JevConfig =>
  ({
    provider: "official",
    apiKey: "test-key",
    baseUrl,
    model: "jev-test",
    callTimeoutMs: 5_000,
    thresholds: { complete: 0.85, looping: 0.7, blocked: 0.75, minConfidence: 0.32 },
  }) as JevConfig;

test("classifyProviderError names each HTTP class", () => {
  assert.equal(classifyProviderError({ status: 429, message: "slow down" }).reason, "rate_limit");
  assert.equal(classifyProviderError({ status: 401, message: "bad key" }).reason, "auth");
  assert.equal(classifyProviderError({ status: 403, message: "denied" }).reason, "auth");
  assert.equal(classifyProviderError({ status: 402, message: "Payment Required" }).reason, "no_credits");
  assert.equal(classifyProviderError({ status: 404, message: "missing" }).reason, "not_found");
  assert.equal(classifyProviderError({ status: 503, message: "down" }).reason, "provider_outage");
  assert.equal(
    classifyProviderError(new Error("getaddrinfo ENOTFOUND openrouter.ai")).reason,
    "unreachable",
  );
  const proxy = classifyProviderError(
    new Error("Unexpected Status or Content-Type: Status 200 Content-Type text/html"),
  );
  assert.equal(proxy.reason, "proxy_interstitial");
  assert.equal(proxy.runStatus, "blocked");
  assert.ok(proxy.summary.includes("HTTP 200") || proxy.httpStatus === 200);
});

test("parseDecisionBody turns HTML into proxy_interstitial", () => {
  assert.throws(
    () => parseDecisionBody("<!DOCTYPE html><html>Proceed with caution</html>", 1),
    (error: unknown) => error instanceof EndpointError && error.reason === "proxy_interstitial",
  );
  assert.throws(
    () => parseDecisionBody({ answers: {} }, 1),
    (error: unknown) => error instanceof EndpointError && error.reason === "bad_response",
  );
});

const stubCases: Array<{
  reason: string;
  status: number;
  body: string;
  contentType?: string;
  runStatus: "error" | "blocked";
}> = [
  { reason: "rate_limit", status: 429, body: '{"error":"rate limit exceeded"}', runStatus: "error" },
  { reason: "auth", status: 401, body: '{"error":"invalid api key"}', runStatus: "error" },
  { reason: "auth", status: 403, body: '{"error":"forbidden"}', runStatus: "error" },
  { reason: "no_credits", status: 402, body: '{"error":"Payment Required"}', runStatus: "error" },
  { reason: "not_found", status: 404, body: '{"error":"model not found"}', runStatus: "error" },
  { reason: "provider_outage", status: 503, body: '{"error":"unavailable"}', runStatus: "error" },
  {
    reason: "proxy_interstitial",
    status: 200,
    body: "<!DOCTYPE html><html><body>Proceed with caution</body></html>",
    contentType: "text/html",
    runStatus: "blocked",
  },
];

for (const row of stubCases) {
  test(`decide surfaces ${row.reason} for HTTP ${row.status}`, async () => {
    const stub = await listen((_req, res) => {
      res.writeHead(row.status, {
        "content-type": row.contentType ?? "application/json",
      });
      res.end(row.body);
    });
    try {
      const client = createJevClient(configFor(stub.url), noTrace);
      await assert.rejects(
        () => client.decide({ task: "x" }, questions),
        (error: unknown) => {
          assert.ok(error instanceof EndpointError);
          assert.equal(error.reason, row.reason);
          assert.equal(error.runStatus, row.runStatus);
          assert.equal(error.httpStatus, row.status);
          assert.ok(isEndpointReason(error.reason));
          assert.match(error.summary, /endpoint /);
          return true;
        },
      );
    } finally {
      await stub.close();
    }
  });
}

test("decide surfaces unreachable when the host never answers", async () => {
  const client = createJevClient(configFor("http://127.0.0.1:1"), noTrace);
  await assert.rejects(
    () => client.decide({ task: "x" }, questions),
    (error: unknown) => error instanceof EndpointError && error.reason === "unreachable",
  );
});
