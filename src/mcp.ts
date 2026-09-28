import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createJevClient, type Questions } from "./jev.js";
import { runAction } from "./loop.js";
import { log } from "./log.js";
import { RAW_GUIDE, RAW_GUIDE_URI } from "./guide.js";

const loopSchema = z
  .object({
    loop: z.object({
      tasks: z
        .array(z.string().min(1))
        .min(1)
        .max(8)
        .describe("Steps to run, in order, once per round."),
      until: z
        .string()
        .min(1)
        .describe(
          "What the finished page shows. Jev reads the live page after every round and answers whether it holds, so name page evidence: \"the cart is empty\", not \"done\".",
        ),
      maxRounds: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Hard ceiling on rounds. Default 12."),
    }),
  })
  .describe("Repeat steps until the page shows `until`. One round per pass.");

/** A written step, or a loop over written steps. */
const taskStepSchema = z.union([z.string().min(1), loopSchema]);

const taskGroupSchema = z.object({
  id: z.string().optional().describe("Label for this series. Echoed back in the result."),
  targetId: z.string().optional().describe("Tab this series runs on."),
  groupId: z.string().optional().describe("Tab group to open a new tab in."),
  startUrl: z.string().optional().describe("Address to open before the first step."),
  goal: z.string().optional().describe("Single step. Use when tasks is omitted."),
  tasks: z.array(taskStepSchema).max(24).optional().describe("Steps in order."),
  noFail: z
    .boolean()
    .optional()
    .describe("Run the rest of this series after a step does not complete. Endpoint faults stop it anyway."),
  expect: z.string().optional().describe("Text that proves this series worked. Checked on the final page."),
});

const runActionSchema = {
  goal: z.string().optional().describe("Single step. Use tasks for a series."),
  tasks: z
    .array(taskStepSchema)
    .max(24)
    .optional()
    .describe("Steps in order on one tab, one action each. An entry may be a loop."),
  groups: z
    .array(taskGroupSchema)
    .max(4)
    .optional()
    .describe(
      "Independent errands, run at the same time, one tab each. Use whenever the work splits across two sites, accounts, or searches, instead of two calls.",
    ),
  noFail: z
    .boolean()
    .optional()
    .describe("Run the rest of the series after a step does not complete. Endpoint faults stop it anyway."),
  expect: z.string().optional().describe("Text that proves the run worked. Checked on the final page."),
  targetId: z.string().optional().describe("Tab to work in. Omit to open one, returned in targetIds."),
  groupId: z.string().optional().describe("Tab group to open a new tab in."),
  startUrl: z.string().optional().describe("Address to open before the first step."),
  values: z
    .record(z.string())
    .optional()
    .describe("Text the steps may type, such as an email. Never a password or a one-time code."),
  contextPaths: z.array(z.string()).optional().describe("Files the steps may read."),
  maxSteps: z
    .number()
    .int()
    .min(1)
    .max(80)
    .optional()
    .describe("Page actions the whole call may spend. Default 40."),
  timeoutMs: z
    .number()
    .int()
    .min(5000)
    .max(240_000)
    .optional()
    .describe(
      "Ceiling for the whole call. Default 90000. On expiry the call returns with the steps that finished plus a handoff naming the rest. Keep it under your client transport timeout: a dropped call still leaves the browser work done.",
    ),
  debug: z
    .boolean()
    .optional()
    .describe("Record every browser call and Jev answer to the JSONL file named in tracePath."),
  returnSnapshot: z.boolean().optional().describe("Include the final page accessibility tree."),
};

/**
 * Detail only some callers reach, kept out of the always-loaded instructions.
 * https://modelcontextprotocol.io/docs/concepts/resources
 */
const RESULT_GUIDE_URI = "jev://reading-a-result";

const RESULT_GUIDE = `# Reading a run_action result

## status

| status | Meaning | Next |
| --- | --- | --- |
| \`completed\` | Step did what it said | Continue |
| \`partial\` | Some work done, more left | Rerun same step |
| \`rejected\` | Page said no | Read \`reason\`. Not a crash |
| \`blocked\` | Sign-in, password, captcha, or proxy interstitial | Read \`handoff\`. Operator clears |
| \`error\` | Endpoint fault | Read \`reason\` + \`handoff\`. Resume. Not a page reject |
| \`unverified\` | Final step done, \`expect\` missing | Check page |
| \`max_steps\` | Budget or clock out | Resume from \`handoff\` |
| \`skipped\` | Earlier step stopped this one | \`noFail\` only for independent page steps |

Group \`status\` = worst case. Read \`counts\` for tally. A loop step also
carries \`rounds\`.

One exception to "a stopped step ends the series": \`rejected\` +
\`already_done\`. The page already shows that step's outcome, so later steps
still run. Group status still reads \`rejected\`; \`verified\` says where the
run landed.

## page reason

| reason | Meaning |
| --- | --- |
| \`no_control\` | Click/press: no control for label, or standing \`none\` won |
| \`no_match\` | Pick (\`open the … result\`): no matching entry, or \`none\` won |
| \`already_done\` | Control absent because page already shows the outcome. Jev judged it. Series carries on |
| \`unavailable\` | Out of stock / not delivered here |
| \`other_route\` | Different route on page |
| \`wrong_page\` | Page not about wanted thing |
| \`not_ready\` | Page still loading |
| \`sign_in\`, \`credentials\`, \`captcha\` | Status \`blocked\`, not \`rejected\` |

## endpoint reason

Not a page answer. Summary has HTTP status + short provider message. Series
stops even under \`noFail\`. \`handoff.resumable\` true when tab exists.

| reason | Cause |
| --- | --- |
| \`rate_limit\` | HTTP 429 |
| \`auth\` | HTTP 401 or 403 |
| \`no_credits\` | HTTP 402 or credits/quota body |
| \`not_found\` | HTTP 404 model or endpoint |
| \`provider_outage\` | HTTP 5xx |
| \`unreachable\` | Timeout, DNS, connection refused |
| \`proxy_interstitial\` | HTTP 200 \`text/html\`. Status \`blocked\` |
| \`bad_response\` | Non-JSON or empty answers |

## proof

\`expect\` set and final step \`completed\`: result carries \`verified\` plus
\`proof\`, the match with about 70 chars either side. Same under \`noFail\` after
an earlier reject. Final step never ran: \`proof: not checked\`.

\`read\` puts page words in task \`text\`.

## handoff

Present when series stops early.

\`\`\`json
{
  "resumable": true,
  "targetId": "A495...",
  "url": "https://www.amazon.in/ap/signin",
  "stoppedAt": "click add to cart",
  "status": "blocked",
  "reason": "credentials",
  "remaining": ["open the cart page"],
  "recent": [{ "step": 4, "operation": "CLICK", "detail": "clicked e42" }]
}
\`\`\`

Resume: \`run_action\` with that \`targetId\` + \`remaining\`. Clear credentials or
captcha in shared tab first when \`blocked\`. Replay completed steps = do them
twice.

## usage

Only with \`debug\`. From API bodies. Failed decide does not bump \`decisions\`.

| Field | Source |
| --- | --- |
| \`inputTokens\`, \`outputTokens\` | Provider \`usage\` on each successful decide |
| \`totalTokens\` | Sum |
| \`decisions\` | Successful Jev calls. Zero OK when harness search or exact label needs no judgment |
| \`textCalls\` | Text-model fills |
| \`costUsd\` | Only when provider returns price |
`;

const questionSchema = z
  .object({
    type: z.enum(["choice", "score", "noul"]).describe("choice picks one option. score rates on ordered levels. noul answers yes or no."),
    instructions: z
      .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
      .describe("The whole question, written out. The id is not sent to the model."),
    criteria: z
      .union([z.record(z.string().nullable()), z.array(z.string())])
      .optional()
      .describe(
        "Options for choice (max 255), keyed by your own names. Ordered levels for score (max 10), as an array, lowest first. For noul, the keys true and false, each describing what that answer means.",
      ),
  })
  .describe("One typed question.");

const rawSchema = {
  state: z
    .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
    .describe("What every question is about. Plain text, or JSON whose fields the instructions name in backticks."),
  questions: z
    .record(questionSchema)
    .describe("Questions keyed by an id you pick. Answers come back under the same ids. Ask them all in one call."),
  model: z.string().optional().describe("Pin a Jev version. Default is the configured model."),
};

const INSTRUCTIONS = `Jev picks labelled options, returns typed answers with probabilities.
Writes no text. Reads no images. You write plan. Each step = one choice on
live page.

Tools:
  run_action   browser steps; Jev chooses per page
  use_jev_raw  typed decision, no browser; use when about to guess

Step shapes (one page each; words from screen):
  search <words>              type into page search box
  open the <words> result     pick list entry; refuse = no_match
  open the <name> page        reach place (cart, account)
  click <label>               press control; refuse = no_control
  repeat <step> until <words> run step per round; Jev judges words on page
  keep clicking <label>       same, until condition derived from label
  clear <thing>               same, delete control harness finds
  read <thing>                return page words
  read the page title and url where am I

One step, one page. Compound goal stays on first page, presses wrong control.
Cart add = three steps:
  search colgate toothpaste
  open the best matching colgate toothpaste result
  click add to cart

Loops. A tasks entry may be a loop instead of a string:
  {"loop": {"tasks": ["click remove"], "until": "the cart is empty",
            "maxRounds": 12}}
Round = body once, then Jev reads live page: does until hold? Between rounds
the server waits for the page's own scripts, not a fixed pause.
Write until as page evidence ("the cart is empty", "no Load more button"),
never "done". Bounded by maxRounds (default 12, ceiling 50), call deadline,
step budget, and 2 rounds that change nothing. Never unbounded.
  completed   page showed until. rounds in the step result
  partial     rounds or budget ran out, or body stalled after working
  rejected + no_control   body pressed nothing and page never showed until

Independent errands go in groups: parallel, one tab each. Groups sharing a
targetId run serial. Each decision sees motive plus steps_done for its series.

Read every step status before next move:
  rejected + no_control|no_match|…     page answered; not crash
  blocked + sign_in|credentials|captcha|proxy_interstitial
  error + rate_limit|auth|no_credits|not_found|provider_outage|
         unreachable|bad_response      endpoint fault; not page reject
On endpoint or blocked: stop. Read handoff. Resume with targetId + remaining.
Replay completed steps = do them twice.
Tables for status, reason, handoff, proof, usage: ${RESULT_GUIDE_URI}

expect = text only finished page produces ("Subtotal (3 items)", not product
name). Checked when final step completed, including after noFail rejects.
End with read when you need page words yourself.

Shared Chrome with agentic-playwright-mcp: pass targetId both ways.
Keep timeoutMs under client transport timeout. Resume beats one long call.

Traps: one tab, two storefronts (search stays in current; set startUrl).
One site, two carts (clear the one that owns the rows).
`;

export interface ServerOptions {
  /** Trace every run, whatever the caller passes. Set by --debug. */
  debug?: boolean;
}

export const createJevServer = (options: ServerOptions = {}): McpServer => {
  const server = new McpServer(
    { name: "jev", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerResource(
    "jev-raw-decisions",
    RAW_GUIDE_URI,
    {
      title: "Writing raw Jev decisions",
      description:
        "Question shapes for use_jev_raw: state, choice, score, noul, criteria rules, confidence, size limits, worked example. Read before the first use_jev_raw call.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: RAW_GUIDE }],
    }),
  );

  server.registerResource(
    "jev-reading-a-result",
    RESULT_GUIDE_URI,
    {
      title: "Reading a run_action result",
      description:
        "Result tables: status, page reason, endpoint reason, handoff and resume, expect and proof, usage fields. Read on rejected, blocked, error, unverified, max_steps, or any unfamiliar reason.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: RESULT_GUIDE }],
    }),
  );

  server.tool(
    "run_action",
    "Drive a browser through steps you write. Jev chooses on each page. Use for search, open, click, and read on live pages, and for several independent errands in one call through groups, one tab each, so two sites never need two calls. Returns a status per step, a handoff when one stops, and the tokens the API reported. Step shapes and status tables are in this server's instructions.",
    runActionSchema,
    async (args) => {
      try {
        if (!args.goal && !args.tasks?.length && !args.groups?.length) {
          throw new Error("run_action needs goal, tasks, or groups");
        }
        const config = loadConfig();
        const result = await runAction({ ...args, debug: args.debug || options.debug }, config);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(message);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                is_finished: true,
                status: "error",
                targetIds: [],
                summary: message,
                steps: [],
                error: message,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "use_jev_raw",
    `Ask Jev one typed question, or several. No browser.

Use whenever a decision has more than one defensible answer and you are about to pick on instinct. Jev returns a probability for every option plus a confidence, so a close call reads close and a clear one reads clear. Anything you would settle by coin flip and call judgment belongs here.

Worth handing over: which fix to do first, which name or design to ship when each has a real trade-off, whether this text meets a bar you can write down, which of two error messages a stranger reads faster, whether a step is risky enough to stop and ask the user, how to rank candidates, which reading of an ambiguous request the user meant.

Ask every question in one call. They share the state, they answer in parallel, and each extra question costs its own tokens and almost no extra time. Three questions over a page of state run about a tenth of a cent.

The answer gives the chosen option, the probability of every option, a confidence, and the tokens the API counted. Question shapes and criteria rules: ${RAW_GUIDE_URI}`,
    rawSchema,
    async (args) => {
      try {
        const ids = Object.keys(args.questions ?? {});
        if (!ids.length) throw new Error("use_jev_raw needs at least one question");
        const config = loadConfig();
        const jev = createJevClient(config);
        const decision = await jev.decide(
          args.state as never,
          args.questions as unknown as Questions,
          args.model ?? config.model,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                model: decision.model ?? args.model ?? config.model,
                answers: decision.answers,
                usage: {
                  inputTokens: decision.usage.inputTokens,
                  outputTokens: decision.usage.outputTokens,
                  totalTokens: decision.usage.inputTokens + decision.usage.outputTokens,
                  ...(decision.usage.costUsd === undefined ? {} : { costUsd: decision.usage.costUsd }),
                },
              }),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(message);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  return server;
};

export const startMcpServer = async (options: ServerOptions = {}): Promise<void> => {
  const server = createJevServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`Jev MCP server ready on stdio${options.debug ? " (tracing every run)" : ""}`);
};
