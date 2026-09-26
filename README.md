# Jev MCP

An MCP server that drives a browser with Jev, TypeSafe's decision model. You write the steps. Jev chooses which control on the page carries out each one. Code owns the clicking, the waiting, and the budgets.

The server has two tools. `run_action` does the browser work. `use_jev_raw` answers one typed question with no browser involved.

## Pair it with agentic-playwright-mcp

This server does not start its own browser. It attaches to the Chrome that [`agentic-playwright-mcp`](https://www.npmjs.com/package/agentic-playwright-mcp) already runs, at `http://127.0.0.1:9223`.

That sharing is the point. Both servers see the same tabs, the same profile, and the same cookies, so a session you signed into once stays signed in. Pass a `targetId` from your own Playwright tools into `run_action`, and pass the `targetId` values it returns back the other way.

If no Chrome is listening, the server starts one of its own.

## Install

```bash
npm install
npm run build
```

The build writes `dist/index.js` and `dist/cli.js`.

## Save an API key

```bash
npx jev setup --provider openrouter --api-key "$OPENROUTER_API_KEY"
```

The command writes `~/.jev/.env`. The MCP server, the CLI, and `runAction` all read that file.

To use a TypeSafe key instead, run this:

```bash
npx jev setup --provider official --api-key "$TYPESAFE_API_KEY"
```

To add this server to `~/.cursor/mcp.json`, pass `--install-cursor`. The command leaves the `agentic-playwright-mcp` entry alone.

To override `~/.jev` inside this repo, copy `.env.example` to `.env` and set the same keys.

## Check the setup

```bash
npx jev doctor
```

The output includes `jev decision: ok` and a `playwright: ok` line with a `targetId`.

## Add the server

Put this in the host `mcp.json`, with `args` pointing at this repo's `dist/index.js`.

```json
{
	"mcpServers": {
		"jev": {
			"command": "node",
			"args": ["E:/Code/jev/dist/index.js"]
		}
	}
}
```

## Write the steps

Jev picks among labelled options and returns typed answers. It does not read plans and does not write text, so you write the plan and each step hands Jev one choice.

| Step | What it does |
| --- | --- |
| `search <words>` | Puts the words in the page's own search box |
| `open the <words> result` | Chooses that entry out of a list |
| `open the <name> page` | Reaches a place, such as the cart page |
| `click <label>` | Presses the control carrying that label |
| `keep clicking <label>` | Presses it until the page stops offering it |
| `clear <thing>` | The same, for a delete control it finds itself |
| `read <thing>` | Hands the page's own words back to you |
| `read the page title and url` | Answers "where am I" without the whole page |

One step, one page. Use the words that appear on the screen, because Jev matches labels literally.

Adding one item to a cart is three steps, one per page.

```json
["search colgate toothpaste", "open the best matching colgate toothpaste result", "click add to cart"]
```

A single `add colgate toothpaste to cart` still runs, but it never leaves the results page, so it presses whatever there carries those words.

Each step starts a fresh Jev loop that sees only the live page, so one step never inherits another's page or history.

### Repetition is a shape, not a shopping word

`clear cart` is one use of a general primitive: press the same control until the page stops offering it. A step that names its own control keeps it, so `keep clicking Load more` works anywhere. A step naming a container instead, such as `clear cart`, falls back to whatever the page uses for delete or remove.

A repeat that gives up with controls still on the page returns `partial`, never `completed`.

### When the outcome already holds

A step that names a control the page no longer carries comes back `rejected` with reason `no_control`. Once an item is in the cart, Flipkart's product page replaces "Add to cart" with "Go to cart", so `click add to cart` finds nothing and says so.

The server does not guess whether that means the work is already done. Judging that from the page finished steps without doing them, so a step that looks satisfied still runs and still reports honestly. End the series with a `read` step and decide from the cart's own words.

## Call run_action

Steps in `tasks` run in order on one tab.

Errands that do not depend on each other belong in `groups`, and they run at the same time, one tab each. Two sites, two accounts, or two separate searches are one call with two groups, never two calls. Reach for `groups` first, and fall back to a single series only when every step needs the page the step before it left. Series sharing a `targetId` run one after another, because they share a tab.

```json
{
	"groups": [
		{
			"id": "cart",
			"targetId": "TAB_A",
			"expect": "subtotal",
			"tasks": [
				"open the cart page",
				"clear cart",
				"search colgate toothpaste",
				"open the best matching colgate toothpaste from the results",
				"click add to cart"
			]
		},
		{
			"id": "other",
			"targetId": "TAB_B",
			"tasks": ["open example.com"]
		}
	]
}
```

## Read the result

The result carries `is_finished`, `targetIds`, `groups`, `status`, `summary`, and a `handoff` when something stopped. Each group carries its own `tasks`, `steps`, and `counts`. `snapshot` appears only when you set `returnSnapshot`, and `usage`, `elapsedMs`, and per-step `ms` only when you set `debug`.

Every step carries its own status.

| Status | What it means |
| --- | --- |
| `completed` | The step did what it said |
| `partial` | It did some of the work and stopped with more to do |
| `rejected` | The page answered no. Read `reason` |
| `blocked` | The page wants something only you can give. Read `handoff` |
| `unverified` | Every step ran, and `expect` was missing from the final page |
| `max_steps` | The budget or the clock ran out |
| `skipped` | An earlier step in the series stopped this one |

A group's `status` is worst-case across its steps, so an eight-of-ten group reads as `rejected`. Read `counts` for what actually happened.

```json
{ "status": "rejected", "counts": { "completed": 12, "rejected": 1 } }
```

Later steps stand on earlier ones, so a step that does not complete ends its series and the rest come back as `skipped` naming the step that stopped them. Set `noFail` on a series whose steps stand alone, and it runs them all.

### Why a step was turned down

| `reason` | Meaning |
| --- | --- |
| `no_control` | Nothing on that page does what the step named |
| `no_match` | The list held no entry matching what the step named |
| `unavailable` | Out of stock, sold out, or not delivered here |
| `other_route` | The page offers a different route, such as other sellers |
| `wrong_page` | The page is not about the wanted thing |
| `not_ready` | The page had not finished loading |
| `sign_in`, `credentials`, `captcha` | Returned as `blocked`, not `rejected` |

## Prove the run worked

A `completed` status is Jev's claim. Set `expect` to the text that proves it, and the server reads the final page for that text. Matching ignores case and spacing.

```json
{ "tasks": ["open the cart page"], "expect": "subtotal (3 items)" }
```

Pick text that only the finished state produces. `Subtotal (3 items)` works. A product name does not, because shops repeat product names in recommendation rails, and a rail can prove an empty cart. The result quotes the words either side of the match in `proof`, so you can see which it matched.

```json
{ "verified": true, "proof": "…All Carts Subtotal (3 items): ₹509.00 Proceed to Buy…" }
```

The check runs only when every step completed. A series that stopped reports `proof: not checked`, rather than claiming the text was missing from a page it never reached.

## Pick up a stopped run

When a series stops early, the result carries a `handoff`.

```json
{
	"resumable": true,
	"targetId": "TAB_A",
	"url": "https://www.amazon.in/ap/signin",
	"stoppedAt": "click add to cart",
	"status": "blocked",
	"reason": "credentials",
	"remaining": ["open the cart page"],
	"recent": [{ "step": 4, "operation": "CLICK", "detail": "clicked e42" }]
}
```

The tab is still open and you already share it, so you can finish the step through your own Playwright tools, ask the user, or call `run_action` again with that `targetId` and the `remaining` steps.

## Pages that stand in the way

Jev is asked on every step whether the page is one where the task can happen at all. When it says no, the server asks why and stops the step with `blocked` and a `reason`.

| `reason` | The page is |
| --- | --- |
| `sign_in` | A sign-in wall |
| `credentials` | Asking for a password or a one-time code |
| `captcha` | Asking the user to prove they are a human |

Those three come back as `blocked` with a handoff, because you own the same tab and can still act. This server never fills a password, a one-time code, or a captcha itself. Type the value in the shared tab, hand it to the user, or stop. Pass ordinary strings such as an email or a postcode in `values`.

Other reasons, such as `unavailable` or `wrong_page`, come back as `rejected`. Those are the page's own answer, not something you can unblock.

## Keep a call short

A call returns on its own clock, which defaults to 90 seconds. On expiry you get a normal result holding the steps that finished and a handoff naming the rest, so you resume by calling again with that `targetId` and the remaining steps.

A call your MCP client drops is the case worth avoiding. The browser work still happens, you never see the result, and running the same steps again does them twice. Keep `timeoutMs` under your client's own transport timeout and resume instead of asking for one long call.

## Token usage and timing

`usage` and `elapsedMs` appear only when you set `debug`, alongside `tracePath`. Every group and task then carries its own `ms`.

`usage` sums what each API response reported. Nothing in it is estimated.

| Field | Source |
| --- | --- |
| `inputTokens` | `usage.input_tokens` on every Jev response |
| `outputTokens` | `usage.output_tokens` on every Jev response |
| `totalTokens` | The two above, added |
| `decisions` | Jev calls made |
| `textCalls` | Calls to the text model that fills a field Jev cannot write |
| `costUsd` | Present only when a provider returns a price |

TypeSafe returns tokens and no price, so `costUsd` is absent on a direct TypeSafe key and present through OpenRouter.

`decisions: 0` is normal and not a failure. A search, a destination, and a control named exactly what the step said all resolve without a judgment, so a run made only of those asks Jev nothing. A recent two-site run of 26 steps cost 19 decisions and about $0.001.

## Ask Jev without a browser

`use_jev_raw` sends state and typed questions straight to Jev. Use it when you are weighing options that read as equally good and you want a calibrated pick instead of a coin flip, or when you want a yes-or-no gate before a costly step.

```json
{
	"state": { "bug": "Checkout throws on an empty cart.", "fixes": { "guard": "...", "schema": "..." } },
	"questions": {
		"pick_fix": {
			"type": "choice",
			"instructions": "Which fix in `fixes` removes the cause of `bug` rather than hiding it?",
			"criteria": { "guard": "Adds a runtime check.", "schema": "Makes the broken state unrepresentable." }
		}
	}
}
```

The answer carries the chosen option, a probability for every option, a confidence, and the tokens the API counted. The server publishes a `jev://raw-decisions` resource with the question shapes, the rules for writing criteria, and the size limits. Read it before the first call.

## What the harness already handles

Leave these out of the plan. The server waits for loads, follows a link that opens its own tab, recovers element refs that went stale between the snapshot and the click, and skips invisible controls that carry real labels.

Finding a control and choosing it are separate. When a step names a control, the server collects every control on the page carrying those words, including ones drawn as plain text with no accessibility role, and Jev picks one or answers that none of them fits. A step that finds nothing it can vouch for comes back `rejected` or `blocked` instead of pressing something at random.

Jev reads text only, so this server works from the page's own text and takes no screenshots. A control drawn without text is found by its DOM text instead.

A step that opens an entry is only done once that entry is up. A click that navigates, opens its own tab, or draws an overlay showing the entry all count. A click that leaves the page exactly as it was does not, so the step tries something else rather than reporting success.

## Traps on real sites

These bit this server in testing and are worth knowing before you write steps.

**One tab, two storefronts.** Amazon Fresh sits beside the main store in the same tab, and the search box keeps you in whichever one the tab is already in. Results there open overlays rather than product pages, so `click add to cart` finds nothing. Pass a `startUrl` that names the store you want, such as `https://www.amazon.in/s?k=colgate+toothpaste`.

**One site, two carts.** Amazon keeps a separate Fresh cart. `clear cart` empties the one you are looking at, and the header count spans both, so a cleared cart can still show items.

**A page with no Add to cart.** When a listing has no default offer, Amazon shows "See All Buying Options" instead. The step comes back `rejected` with `no_control` or `other_route`. That is the page's answer, not a failure to retry.

**A product that does not exist there.** Flipkart sells no plain Coca-Cola outside Flipkart Minutes, which needs a signed-in account. Expect `no_match`, or a near-miss substitution you should check with a `read` step.

## Debug a run

Set `debug` on a call to write every browser call and Jev decision to a JSONL file. The result names it in `tracePath`.

To trace every run whatever the caller passes, add `--debug` to the server command.

```json
{
	"mcpServers": {
		"jev": {
			"command": "node",
			"args": ["E:/Code/jev/dist/index.js", "--debug"]
		}
	}
}
```

Traces land in `~/.jev/traces`, one file per run.

## Run one goal from the CLI

```bash
npx jev run "Open example.com and click More information" --snapshot
```

Add `--expect` to check the final page, `--task` to write a series, and `--groups-json` for parallel groups.

## Call runAction from code

```ts
import { runAction } from "jev-mcp";

const result = await runAction({
	tasks: ["open the cart page", "clear cart"],
	expect: "your cart is empty",
});

console.log(result.status, result.verified, result.usage.totalTokens);
```
