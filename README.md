# jev-browser-sidekick-mcp

[![npm](https://img.shields.io/npm/v/jev-browser-sidekick-mcp)](https://www.npmjs.com/package/jev-browser-sidekick-mcp)
[![CI](https://github.com/TechyAditya/jev-browser-sidekick-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TechyAditya/jev-browser-sidekick-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/jev-browser-sidekick-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/jev-browser-sidekick-mcp)](LICENSE)

An MCP server that drives a browser with Jev, TypeSafe's decision model. You write the steps. Jev chooses which control on the page carries out each one. The server does the clicking and the waiting, and it keeps the budgets.

The server has two tools. `run_action` does the browser work. `use_jev_raw` answers one typed question with no browser involved.

Jev named the package. Six candidates went into `use_jev_raw` with the download counts of every competing package and the trade-offs of each name written out. It picked this one at a probability of 0.66, against 0.17 for the runner-up, and it cost $0.000058 to ask. The maintainer had argued for a different name and lost.

## Install agentic-playwright-mcp alongside it

Install [agentic-playwright-mcp](https://www.npmjs.com/package/agentic-playwright-mcp) as well. This server runs at its best with that one beside it, and the two are built to be used together.

This server does not start its own browser. It attaches to the Chrome that `agentic-playwright-mcp` already runs, at `http://127.0.0.1:9223`. One Chrome, one profile, one set of cookies, shared by both servers and by your agent. A site you signed into through your Playwright tools is still signed in when a step runs here, and a cart this server filled is still there when you look at it yourself.

That shared session is what makes the pair stable. Pass a `targetId` from your Playwright tools into `run_action`, and pass the `targetId` values it returns back the other way, and both sides act on the same tab. When a step stops as `blocked` on a password or a captcha, the tab is one you already hold, so you can finish it in place and resume.

If no Chrome is listening, this server starts one of its own. It works, but nothing else can see that browser, so you lose the handoff and the sign-in you already had.

## Install

Install both globally. `agentic-playwright-mcp` is a peer dependency, so npm pulls it in on its own, but naming it here also puts its commands on your `PATH`.

```bash
npm install -g agentic-playwright-mcp jev-browser-sidekick-mcp
```

That gives you four commands, a long form and a short form for each package.

| Long | Short | What it runs |
| --- | --- | --- |
| `jev-browser-sidekick-mcp` | `jev-bro` | This server, and its `setup`, `doctor`, and `run` subcommands |
| `agentic-playwright-mcp` | `apmcp` | The browser this server attaches to |

npm writes a `.cmd` and a `.ps1` shim next to each command on Windows, so all four work unchanged in PowerShell, in cmd, in Git Bash, and in WSL.

To skip the install and fetch on demand, use `npx --yes` with the full package name. `npx` resolves a package name rather than a command name, so `npx --yes jev-bro` does not work.

```bash
npx --yes jev-browser-sidekick-mcp doctor
```

## Save an API key

```bash
jev-bro setup --provider openrouter --api-key "$OPENROUTER_API_KEY"
```

In PowerShell, use `$env:OPENROUTER_API_KEY`. In cmd, use `%OPENROUTER_API_KEY%`.

The command writes `~/.jev/.env`. The MCP server, the CLI, and `runAction` all read that file.

To use a TypeSafe key instead, run this command.

```bash
jev-bro setup --provider official --api-key "$TYPESAFE_API_KEY"
```

To add this server to `~/.cursor/mcp.json`, pass `--install-cursor`. The command leaves the `agentic-playwright-mcp` entry alone.

To override `~/.jev` inside this repo, copy `.env.example` to `.env` and set the same keys.

## Check the setup

```bash
jev-bro doctor
```

The output includes `jev decision: ok` and a `playwright: ok` line with a `targetId`.

## Add the servers

Put both in the host `mcp.json`. Neither needs a path, and `npx` fetches them on first run.

```json
{
	"mcpServers": {
		"playwright": {
			"command": "npx",
			"args": ["--yes", "agentic-playwright-mcp"]
		},
		"jev": {
			"command": "npx",
			"args": ["--yes", "jev-browser-sidekick-mcp"]
		}
	}
}
```

Start the `playwright` entry first, or just let the host start both. This server looks for that Chrome on every call, so the order only decides whether the first call attaches or opens its own browser.

## Write the steps

Jev picks among labelled options and returns typed answers. It does not read plans and does not write text, so you write the plan and each step hands Jev one choice.

| Step                          | What it does                                   |
| ----------------------------- | ---------------------------------------------- |
| `search <words>`              | Puts the words in the page's own search box    |
| `open the <words> result`     | Chooses that entry out of a list               |
| `open the <name> page`        | Reaches a place, such as the cart page         |
| `click <label>`               | Presses the control carrying that label        |
| `repeat <step> until <words>` | Runs that step once a round until the page shows those words |
| `keep clicking <label>`       | The same, with the condition read off the label |
| `clear <thing>`               | The same, for a delete control it finds itself |
| `read <thing>`                | Hands the page's own words back to you         |
| `read the page title and url` | Answers "where am I" without the whole page    |

Each step acts on one page. Use the words that appear on the screen, because Jev matches labels literally.

Adding one item to a cart is three steps, one per page.

```json
["search colgate toothpaste", "open the best matching colgate toothpaste result", "click add to cart"]
```

A single `add colgate toothpaste to cart` still runs, but it never leaves the results page, so it presses whatever on that page carries those words.

Each step runs against the live page. The decision also sees the series `motive` and a short `steps_done` line for each finished task, so Jev can refuse a step that earlier work already covered. Groups running in parallel share nothing, so each one sees only its own motive and its own finished steps.

### Repeat steps until the page says to stop

A loop runs its body once a round, then Jev reads the live page and answers one question: does the condition hold yet? Clearing a cart is one use of it. Any page that hands back one item at a time needs the same shape.

```json
["repeat click remove until the cart is empty"]
```

The condition ends the loop, not a control disappearing. A site that redraws its list between rounds offers no controls for a moment, and reading that as "finished" reports an untouched cart as cleared. Write the condition as something the page shows, such as `the cart is empty`, rather than `done`.

A step that names its own control derives its condition, so `keep clicking Load more` and `clear cart` still work as written. Between rounds the server waits for the page's own scripts rather than a fixed pause, because a row that a site deletes over the network lands whenever its request comes back.

For a body of more than one step, pass a loop object in `tasks`.

```json
{
	"tasks": [
		"open the cart page",
		{ "loop": { "tasks": ["click remove", "click confirm"], "until": "the cart is empty", "maxRounds": 20 } },
		"read the cart"
	]
}
```

No loop runs forever. Five things end one: the condition, the round ceiling (`maxRounds`, 12 by default and never above 50), the call's own deadline, the step budget, and two rounds that change nothing. The step reports `completed` when the page showed the condition, `partial` when a ceiling stopped it with work left, and `rejected` with `no_control` when the body pressed nothing at all. Every loop step carries the `rounds` it ran.

### When the outcome already holds

A step that names a control the page no longer carries comes back `rejected`. For example, once an item is in the cart, a product page can replace "Add to cart" with "Go to cart", so `click add to cart` finds nothing.

Two different things cause that, and the caller acts differently on each: the page cannot do the step at all, or the page already shows the step's outcome. The server does not guess from the URL or the title, because that guess marked steps finished that had never run. Jev reads the page instead, and an outcome already in place comes back as `rejected` with reason `already_done`.

The series carries on past an `already_done` step, because the ground the next step stands on is there, whoever put it there. The group still reports `rejected`, so a run reads honestly, and `verified` says where it landed.

## Call run_action

Steps in `tasks` run in order on one tab.

Errands that do not depend on each other belong in `groups`, and they run at the same time, one tab each. Two sites, two accounts, or two separate searches are one call with two groups, never two calls. Use `groups` first, and fall back to a single series only when every step needs the page the step before it left. Series that share a `targetId` run one after another, because they share a tab.

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

The result has `is_finished`, `targetIds`, `groups`, `status`, `summary`, and a `handoff` when something stopped. Each group has its own `tasks`, `steps`, and `counts`. `snapshot` appears only when you set `returnSnapshot`, and `usage`, `elapsedMs`, and per-step `ms` only when you set `debug`.

Every step has its own status.

| Status       | What it means                                                              |
| ------------ | -------------------------------------------------------------------------- |
| `completed`  | The step did what it said                                                  |
| `partial`    | It did some of the work and stopped with more to do                        |
| `rejected`   | The page answered no. Read `reason`                                        |
| `blocked`    | Sign-in, password, captcha, or a proxy interstitial. Read `handoff`        |
| `unverified` | The final step completed, and `expect` was missing from the page           |
| `error`      | The Jev provider or the network failed. Read `reason` and `handoff`        |
| `max_steps`  | The budget or the clock ran out                                            |
| `skipped`    | An earlier step in the series stopped this one                             |

A group's `status` is worst-case across its steps, so a group where eight of ten steps completed still reads as `rejected`. Read `counts` for what actually happened.

```json
{ "status": "rejected", "counts": { "completed": 12, "rejected": 1 } }
```

Later steps depend on earlier ones, so a step that does not complete ends its series, and the rest come back as `skipped` naming the step that stopped them. Set `noFail` on a series whose steps are independent, and it runs them all.

One reason is exempt. A step that came back `rejected` with `already_done` did not stop anything, because what the next step needs is already on the page.

### Why a step was turned down

| `reason`                            | Meaning                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `no_control`                        | A `click` or press found no control that does what the step named |
| `no_match`                          | An `open the … result` step found no matching entry      |
| `already_done`                      | The control is gone because the page already shows the outcome |
| `unavailable`                       | Out of stock, sold out, or not delivered here            |
| `other_route`                       | The page offers a different route, such as other sellers |
| `wrong_page`                        | The page is not about the wanted thing                   |
| `not_ready`                         | The page had not finished loading                        |
| `sign_in`, `credentials`, `captcha` | Returned as `blocked`, not `rejected`                    |

A standing `none` choice that wins uses the same reasons: `no_control` for click or press, `no_match` for pick.

## Prove the run worked

A `completed` status is Jev's claim. Set `expect` to the text that proves it, and the server reads the final page for that text. Matching ignores case and spacing.

```json
{ "tasks": ["open the cart page"], "expect": "subtotal (3 items)" }
```

Pick text that only the finished state produces. `Subtotal (3 items)` works. A product name does not. Shops repeat product names in recommendation rails, so that text matches even on an empty cart. The result quotes the words either side of the match in `proof`, so you can see which it matched.

```json
{ "verified": true, "proof": "…All Carts Subtotal (3 items): ₹509.00 Proceed to Buy…" }
```

The check runs when the final step of the series completed, including under `noFail` after an earlier rejection. A series whose final step never ran reports `proof: not checked`, rather than claiming the text was missing from a page it never reached.

## Pick up a stopped run

When a series stops early, the result includes a `handoff`.

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

## Pages that block a step

These reasons come back as `blocked` with a handoff, because you own the same tab and can still act.

| `reason`      | The page is                               |
| ------------- | ----------------------------------------- |
| `sign_in`     | A sign-in wall                            |
| `credentials` | Asking for a password or a one-time code  |
| `captcha`     | Asking the user to prove they are a human |

Finding the words and believing them are separate. The harness spots the words a sign-in wall or a challenge uses, and Jev reads the page and confirms the page is really demanding one. A news story titled "Solving a corn puzzle with CP-SAT" carries the same word a challenge does, and stopping a series on that costs more than the check saves.

This server never fills a password, a one-time code, or a captcha itself. Type the value in the shared tab, hand it to the user, or stop. Pass ordinary strings such as an email or a postcode in `values`.

A missing control is not `blocked`. It is `rejected` with `no_control` or `no_match`, as in the reason table above.

## When the provider fails

A fault in the Jev API or the network is not a page answer. The step returns `error` with a reason that names the cause. An HTTP proxy that returns HTML with status 200 is the exception: that comes back as `blocked` with reason `proxy_interstitial`, because only you can clear the proxy.

| `reason`             | Typical cause                                      |
| -------------------- | -------------------------------------------------- |
| `rate_limit`         | HTTP 429                                           |
| `auth`               | HTTP 401 or 403                                    |
| `no_credits`         | HTTP 402, or a credits or quota message            |
| `not_found`          | HTTP 404 for a model or endpoint                   |
| `provider_outage`    | HTTP 5xx                                           |
| `unreachable`        | Timeout, DNS failure, or connection refused        |
| `proxy_interstitial` | HTTP 200 with a `text/html` body                   |
| `bad_response`       | Non-JSON body or empty answers                     |

The summary includes the HTTP status and a short provider message. The series stops even when `noFail` is set. `handoff.resumable` stays true when a tab exists, so you resume with that `targetId` and the remaining steps instead of redoing work that already finished.

## Keep a call short

A call returns after its own timeout, which defaults to 90 seconds. On expiry you get a normal result holding the steps that finished and a handoff naming the rest, so you resume by calling again with that `targetId` and the remaining steps.

A call your MCP client drops is the case worth avoiding. The browser work still happens, you never see the result, and running the same steps again does them twice. Keep `timeoutMs` under your client's own transport timeout and resume instead of asking for one long call.

## Token usage and timing

`usage` and `elapsedMs` appear only when you set `debug`, alongside `tracePath`. Every group and task then carries its own `ms`.

`usage` sums what each API response reported. Nothing in it is estimated.

| Field          | Source                                                      |
| -------------- | ----------------------------------------------------------- |
| `inputTokens`  | `usage.input_tokens` on every Jev response                  |
| `outputTokens` | `usage.output_tokens` on every Jev response                 |
| `totalTokens`  | The two above, added                                        |
| `decisions`    | Successful Jev calls. A failed decide does not count        |
| `textCalls`    | Calls to the text model that fills a field Jev cannot write |
| `costUsd`      | Present only when a provider returns a price                |

TypeSafe returns tokens and no price, so `costUsd` is absent on a direct TypeSafe key and present through OpenRouter.

`decisions: 0` is normal and not a failure. A search, a destination, and a control labelled exactly what the step said all resolve without a judgment call, so a run made only of those asks Jev nothing. A recent two-site run of 26 steps cost 19 decisions and about $0.001.

## Ask Jev without a browser

`use_jev_raw` sends state and typed questions straight to Jev. Use it whenever a decision has more than one defensible answer and you are about to pick on instinct: which fix to do first, which name to ship when each has a real trade-off, whether a draft meets a bar you can write down, whether a step is risky enough to stop and ask the user.

You get a probability for every option and a confidence, so a close call reads as close. Ask every question you have in one call, because they share the state and answer in parallel. Three questions over a page of state run about a tenth of a cent.

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

The answer has the chosen option, a probability for every option, a confidence, and the tokens the API counted. The server publishes a `jev://raw-decisions` resource with the question types, the rules for writing criteria, and the size limits. Read it before the first call.

Nothing says the state has to be about code. If you are the sort of person who stands in the cereal aisle for ten minutes, your sidekick will happily take that one too. Give it the four job offers, the three flat listings, the cat names, or what to cook tonight, write down what you actually care about in `criteria`, and it tells you which one it likes and how sure it is. A tenth of a cent for a friend who never answers "I don't know, what do you want to do" is a fair trade. It already picked this package's name, and it was right.

## What the server already handles

Leave these out of the plan. The server waits for loads, follows a link that opens its own tab, recovers element references that went stale between the snapshot and the click, and skips invisible controls that carry real labels.

Finding a control and choosing it are separate. When a step names a control, the server collects every control on the page carrying those words, including ones drawn as plain text with no accessibility role. Jev picks one of them, or the standing `none` option when none fits. A pick step does the same over entry candidates that name the subject. When nothing fits, the step returns `rejected` instead of pressing something else.

Jev reads text only, so this server works from the page's own text and takes no screenshots. A control drawn without text is found by its DOM text instead.

A step that opens an entry is done only once the page shows that entry. A click that navigates, opens its own tab, or draws an overlay showing the entry all count. A click that leaves the page exactly as it was does not count, so the step tries something else rather than reporting success.

## Traps on real sites

Each of these cost real runs in testing. Shopping sites found them, but nothing about them is particular to shopping.

**One tab, two storefronts.** A site can run more than one storefront in the same tab, and its search box keeps you in whichever one the tab is already in. Results in the wrong storefront open overlays rather than their own pages, so a `click` step finds nothing. Pass a `startUrl` that names the storefront you want. For example, Amazon Fresh sits beside the main Amazon store in one tab.

**One site, two collections.** A site can keep more than one cart, list, or queue, and show a count that spans all of them, so a collection you just emptied still reads as full. The page that lists everything usually shows the other collection read-only, with a link in place of the per-row controls, so a `clear` step there presses nothing and returns `rejected` with `no_control`. Open the collection that owns the items first. For example:

```json
["open the cart page", "click Go to Fresh Cart", "clear cart"]
```

**A page that offers a different route.** When the usual action is unavailable, a page often puts another control in its place. The step returns `rejected` with `no_control` or `other_route`. That is the page's answer, not a failure to retry. For example, a listing with no default offer shows "See All Buying Options" where "Add to cart" would be.

**A near miss in place of a match.** A search can answer with something close rather than the thing you named, most often when the real item sits behind a sign-in or in another storefront. Expect `no_match`, or check the substitution with a `read` step.

## Debug a run

Set `debug` on a call to write every browser call and Jev decision to a JSONL file. The result names it in `tracePath`.

To trace every run whatever the caller passes, add `--debug` to the server command.

```json
{
	"mcpServers": {
		"jev": {
			"command": "npx",
			"args": ["--yes", "jev-browser-sidekick-mcp", "--debug"]
		}
	}
}
```

Traces land in `~/.jev/traces`, one file per run.

## Run one goal from the CLI

```bash
jev-bro run "Open example.com and click More information" --snapshot
```

Add `--expect` to check the final page, `--task` to write a series, and `--groups-json` for parallel groups.

## Call runAction from code

```bash
npm install jev-browser-sidekick-mcp
```

```ts
import { runAction } from "jev-browser-sidekick-mcp";

const result = await runAction({
	tasks: ["open the cart page", "clear cart"],
	expect: "your cart is empty",
});

console.log(result.status, result.verified, result.usage.totalTokens);
```

