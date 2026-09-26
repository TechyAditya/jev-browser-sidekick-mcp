import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createJevClient, type Questions } from "./jev.js";
import { runAction } from "./loop.js";
import { log } from "./log.js";
import { RAW_GUIDE, RAW_GUIDE_URI } from "./guide.js";

const taskGroupSchema = z.object({
  id: z.string().optional().describe("Label for this series, echoed back in the result."),
  targetId: z.string().optional().describe("Tab this series runs on."),
  groupId: z.string().optional().describe("Tab group to open a new tab in."),
  startUrl: z.string().optional().describe("Address to open before the first step."),
  goal: z.string().optional().describe("A single step, when tasks is omitted."),
  tasks: z.array(z.string().min(1)).max(24).optional().describe("The steps, in order."),
  noFail: z
    .boolean()
    .optional()
    .describe("Run the rest of this series even after a step that did not complete."),
  expect: z
    .string()
    .optional()
    .describe("Text that proves this series worked. Read off the final page."),
});

const runActionSchema = {
  goal: z.string().optional().describe("A single step. Use tasks for a series."),
  tasks: z
    .array(z.string().min(1))
    .max(24)
    .optional()
    .describe("Steps in order on one tab, one primitive action each."),
  groups: z
    .array(taskGroupSchema)
    .max(4)
    .optional()
    .describe(
      "Independent errands, run at the same time, one tab each. Use this whenever the work splits across two sites, accounts, or searches instead of calling the tool twice.",
    ),
  noFail: z
    .boolean()
    .optional()
    .describe("Run the rest of the series even after a step that did not complete."),
  expect: z
    .string()
    .optional()
    .describe("Text that proves the run worked. Read off the final page."),
  targetId: z
    .string()
    .optional()
    .describe("Tab to work in. Omit to open one, which is returned in targetIds."),
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
      "Ceiling for the whole call. Default 90000. On expiry the call returns normally with the steps that finished and a handoff naming the rest. Keep it under your own client's transport timeout, because a dropped call still leaves the browser work done.",
    ),
  debug: z
    .boolean()
    .optional()
    .describe("Record every browser call and Jev answer to the JSONL file named in tracePath."),
  returnSnapshot: z
    .boolean()
    .optional()
    .describe("Include the final page's accessibility tree."),
};

/**
 * Detail only some callers reach, kept out of the always-loaded instructions.
 * https://modelcontextprotocol.io/docs/concepts/resources
 */
const RESULT_GUIDE_URI = "jev://reading-a-result";

const RESULT_GUIDE = `# Reading a run_action result

## Per step

Every task carries its own \`status\` and \`summary\`, and \`reason\` when a page
turned it down.

| status | What it means | What to do |
| --- | --- | --- |
| \`completed\` | The step did what it said | Nothing |
| \`partial\` | It did some of the work and stopped | Run the step again |
| \`rejected\` | The page answered no | Read \`reason\`. Treat it as information |
| \`blocked\` | The page wants something only you can give | Read \`handoff\` |
| \`unverified\` | Every step ran, \`expect\` was not on the page | Check the page yourself |
| \`max_steps\` | The budget or the clock ran out | Resume from \`handoff\` |
| \`skipped\` | An earlier step stopped this one | Set \`noFail\` if the steps stand alone |

\`reason\` values: \`sign_in\`, \`credentials\`, \`captcha\` hand back to you.
\`unavailable\`, \`wrong_page\`, \`no_control\`, \`other_route\`, \`not_ready\` are the
page's own answer. \`no_control\` means nothing on that page carried the label
the step named, and the step refused to press anything else.

## proof

A group carrying \`expect\` reports \`verified\` and \`proof\`. \`proof\` is the
expected text with about 70 characters either side, so you can tell a cart
line from a recommendation rail:

\`\`\`json
{ "verified": true, "proof": "…Subtotal (3 items): ₹2,169.00 Proceed to Buy…" }
\`\`\`

A \`read\` step is the stronger check. It puts the page's own words in the
task's \`text\` field, with no judgment in between.

## handoff

Present whenever a series stopped early.

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

Call run_action again with that \`targetId\` and the \`remaining\` steps. The tab
is the one your own browser tools see, so you can finish the stopped step
there first.

## usage and timing

Both appear only when \`debug\` is set, alongside \`tracePath\`. \`elapsedMs\` is the
whole call, and every group and task carries its own \`ms\`.

Token counts are summed from what each API response reported. Nothing is
estimated.

| Field | Source |
| --- | --- |
| \`inputTokens\`, \`outputTokens\` | \`usage.input_tokens\` and \`usage.output_tokens\` on every Jev response |
| \`totalTokens\` | The two above, added |
| \`decisions\` | Jev calls made. Zero is normal: a search, a destination, and a control named exactly what the step said all resolve without a judgment |
| \`textCalls\` | Calls to the text model that fills a field Jev cannot write |
| \`costUsd\` | Only when a provider returns a price. Absent on a direct TypeSafe key |

## debug

Set \`debug\` and every browser call and Jev decision is written to the JSONL
file named in \`tracePath\`.
`;

const questionSchema = z
  .object({
    type: z.enum(["choice", "score", "noul"]).describe("choice picks one option. score rates on ordered levels. noul answers yes or no."),
    instructions: z
      .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
      .describe("The whole question, written out. The question id is not sent to the model."),
    criteria: z
      .union([z.record(z.string().nullable()), z.array(z.string())])
      .optional()
      .describe("Options for choice (max 255), ordered levels for score (max 10), yes and no wording for noul."),
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

const INSTRUCTIONS = `Jev is a decision model. It picks among labelled options and returns typed
answers with probabilities. It writes no text and reads no images, so you
write the plan and each step hands Jev one choice.

run_action drives a real browser. use_jev_raw is the rare case: one typed
decision with no browser in it.

The step shapes, one page each:
  search <words>              put the words in the page's own search box
  open the <words> result     choose that entry out of a list
  open the <name> page        reach a place, such as the cart page
  click <label>               press the control carrying that label
  keep clicking <label>       press it until the page stops offering it
  clear <thing>               the same, for a delete control it finds itself
  read <thing>                hand the page's own words back to you
  read the page title and url answer "where am I" without the whole page

One step, one page. Use the words on the screen. Jev matches labels literally.

A click step stays on the page it was handed. When no control there carries
the label, it comes back rejected with reason no_control rather than pressing
something else. End a series with a read step when you want to see the
outcome for yourself.

Adding one item to a cart is three steps, one per page:
  search colgate toothpaste
  open the best matching colgate toothpaste result
  click add to cart
A single "add colgate toothpaste to cart" runs, but it never leaves the
results page, so it presses whatever there carries those words.

A step whose outcome already holds comes back rejected with reason
no_control, because the page no longer carries the control: once an item is
in the cart the button reads "Go to cart". Read the cart with a read step
when you need to know which it was.

Independent errands belong in groups, and run at the same time, one tab each.
Two sites, two accounts, or two searches are one call with two groups:
  {"groups": [
    {"id": "amazon",   "startUrl": "https://amazon.in",   "tasks": ["...", "..."]},
    {"id": "flipkart", "startUrl": "https://flipkart.com", "tasks": ["...", "..."]}
  ]}
Steps inside a group run in order on its tab, each seeing only the live page.
Groups sharing a targetId run one after another, because they share the tab.

Read every step's own status:
  completed   the step did what it said
  partial     it did some of the work and stopped with more to do
  rejected    the page answered no, such as out of stock. Read reason.
  blocked     the page wants something only you can give. Read handoff.
  unverified  every step ran, and expect was missing from the final page
  skipped     an earlier step stopped this one. noFail runs them anyway.

Set expect to the text that proves the run worked, and pick text only the
finished state produces: "Subtotal (3 items)" rather than a product name,
which also appears in recommendation rails. The result quotes the words
around the match in proof, so you can see which it matched.

Each group also reports counts, such as {"completed": 8, "rejected": 1}. The
status is worst-case across the series; the counts are what happened.

A sign-in wall, a password, a one-time code, or a captcha stops the step as
blocked. The handoff names the tab, the URL, the step that stopped, and the
steps left. Keep calls short for the same reason: a call returns on its own
clock with a handoff for the rest, while a call your client drops leaves the
browser work done and invisible, so repeating those steps does them twice.

This server drives the Chrome that agentic-playwright-mcp runs, so the tabs,
the profile, and the cookies are the ones your own browser tools see. Pass
targetId both ways, and finish a blocked step there yourself.

Two traps worth knowing on shopping sites. A site can run more than one
storefront in one tab, such as Amazon Fresh beside the main store, and a
search box keeps you in whichever one the tab is already in; pass a startUrl
that names the store you want. A site can also keep more than one cart, so
clearing one leaves the other, and a cart count can span both.`;

export interface ServerOptions {
  /** Trace every run, whatever the caller passes. Set by --debug. */
  debug?: boolean;
}

export const createJevServer = (options: ServerOptions = {}): McpServer => {
  const server = new McpServer(
    { name: "jev", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerResource(
    "jev-raw-decisions",
    RAW_GUIDE_URI,
    {
      title: "Writing raw Jev decisions",
      description:
        "How to write state, choice, score, and noul questions for use_jev_raw: criteria rules, confidence, size limits, and worked examples. Read before the first use_jev_raw call.",
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
        "Every status and reason a step can carry, the handoff shape and how to resume from it, and what each usage field counts. Read when a run comes back rejected, blocked, unverified, or max_steps.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: RESULT_GUIDE }],
    }),
  );

  server.tool(
    "run_action",
    "Drive a browser through steps you write, with Jev choosing on each page. Covers several independent errands in one call through groups, one tab each, so two sites never need two calls. Returns a status per step, a handoff when one stops, and the tokens the API reported. Read this server's instructions for the step shapes.",
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
    `Ask Jev one typed question, or several, with no browser involved. Use it when you are weighing options that read as equally good and you want a calibrated pick instead of a coin flip: which of these fixes first, does this text meet the bar, rank these candidates, is this step risky. Returns the chosen option, the probability of every option, confidence, and the tokens the API reported. Read the ${RAW_GUIDE_URI} resource before the first call; it carries the question shapes and the criteria rules.`,
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
