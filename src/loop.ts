import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EntryType } from "@typesafe-ai/sdk";
import { compose } from "./compose.js";
import { loadConfig, requireApiKey } from "./config.js";
import { buildAllowlist, looksLikePath, readAllowedFile } from "./files.js";
import { extractFindTerms, extractUrls, extractValueCandidates } from "./extract.js";
import {
  clickStable,
  findLabelCandidates,
  findLinkTo,
  followNewTab,
  pressUntilGone,
  reachedDestination,
  readPageText,
  searchOnPage,
  showsChoice,
  type LabelCandidate,
} from "./act.js";
import { matchesActionLabel, parseIntent, type TaskIntent } from "./intent.js";
import { createContextBudget, estimateTokens, type ContextBudget } from "./budget.js";
import { createDeadline, withTimeout, type Deadline } from "./timeout.js";
import { createTrace, noTrace, type Trace } from "./trace.js";
import { choiceOf, createJevClient, noulOf, type DecisionUsage, type JevClient } from "./jev.js";
import { log } from "./log.js";
import { clusterByTab, resolveGroups, type PlannedGroup } from "./plan.js";
import { connectPlaywright, type PlaywrightSession } from "./playwright.js";
import {
  availableOperations,
  buildActionSpace,
  buildBlockerQuestions,
  buildControlQuestions,
  buildQuestions,
  controlOption,
  describeCandidate,
  NO_CONTROL,
} from "./questions.js";
import {
  actionNearEntry,
  clip,
  elementTable,
  proofContext,
  isClickable,
  isNoise,
  isSecretField,
  looksLikeSearchResults,
  mentions,
  pageShows,
  prioritize,
  resultCandidates,
  secretDemand,
  shortRef,
  shortUrl,
  type PageElement,
} from "./snapshot.js";
import { generateTypeText } from "./text.js";
import type {
  BlockReason,
  GroupResult,
  Handoff,
  JevConfig,
  RunActionInput,
  RunActionResult,
  RunStatus,
  RunStep,
  TaskResult,
  UsageTotals,
} from "./types.js";

const TASK_STEPS = 12;
const STATE_CAP = 4000;
/** A read step is for checking an outcome, not for scraping a whole site. */
const READ_CAP = 6000;
/** Prior outcomes stay short so motive + history stays near 1% of the state budget. */
const STEPS_DONE_CAP = 600;

/** The series motive: an explicit goal, or the planned tasks joined. */
const seriesMotive = (group: PlannedGroup): string =>
  clip((group.goal?.trim() || group.tasks.join("; ")).trim(), 240);

/** One short clause per finished task so Jev sees why earlier steps landed. */
const formatStepsDone = (prior: TaskResult[]): string => {
  if (!prior.length) return "";
  return clip(
    prior
      .map((row) => {
        const why = row.reason ? ` ${row.reason}` : "";
        return `${row.status}${why}: ${clip(row.summary || row.goal, 80)}`;
      })
      .join(" | "),
    STEPS_DONE_CAP,
  );
};

const noUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  decisions: 0,
  textCalls: 0,
});

/** Every count here comes from a response body. None of it is estimated. */
const addUsage = (total: UsageTotals, part: DecisionUsage, kind: "decision" | "text"): void => {
  total.inputTokens += part.inputTokens;
  total.outputTokens += part.outputTokens;
  total.totalTokens += part.inputTokens + part.outputTokens;
  if (kind === "decision") total.decisions += 1;
  else total.textCalls += 1;
  if (part.costUsd !== undefined) {
    total.costUsd = (total.costUsd ?? 0) + part.costUsd;
  }
};

const mergeUsage = (into: UsageTotals, part: UsageTotals): void => {
  into.inputTokens += part.inputTokens;
  into.outputTokens += part.outputTokens;
  into.totalTokens += part.totalTokens;
  into.decisions += part.decisions;
  into.textCalls += part.textCalls;
  if (part.costUsd !== undefined) {
    into.costUsd = (into.costUsd ?? 0) + part.costUsd;
  }
};

/** The URL already says what kind of page this is, so code decides, not Jev. */
const pageKindOf = (url: string): string => {
  if (/\/gp\/cart|\/cart\b/i.test(url)) return "cart";
  if (/\/checkout|\/spc\/|\/buy\b/i.test(url)) return "checkout";
  if (/\/s\?|\/s\/|search/i.test(url)) return "results";
  if (/\/dp\/|\/gp\/product|\/gp\/aw\/d\//i.test(url)) return "product";
  return "other";
};

const pageLooksEmpty = (url?: string, title?: string): boolean => {
  const current = (url ?? "").toLowerCase();
  return !current || current === "about:blank" || current.startsWith("chrome://") || !title;
};

const signature = (operation: string, target?: string): string => `${operation}:${target ?? ""}`;

const rollup = (rows: { status: RunStatus }[]): RunStatus => {
  if (!rows.length) return "error";
  if (rows.some((row) => row.status === "error")) return "error";
  if (rows.every((row) => row.status === "completed")) return "completed";
  // A skipped step reports the step that stopped the series, not itself.
  const ran = rows.filter((row) => row.status !== "skipped");
  if (ran.every((row) => row.status === "completed")) return "completed";
  if (rows.some((row) => row.status === "unverified")) return "unverified";
  if (rows.some((row) => row.status === "partial")) return "partial";
  // A page that said no is an answer, so a run of answers is not a failure.
  if (ran.every((row) => row.status === "completed" || row.status === "rejected")) {
    return "rejected";
  }
  if (rows.some((row) => row.status === "max_steps")) return "max_steps";
  return "blocked";
};

export const runAction = async (
  input: RunActionInput,
  config: JevConfig = loadConfig(),
): Promise<RunActionResult> => {
  requireApiKey(config);
  const planned = resolveGroups(input);
  if (!planned.some((group) => group.tasks.length)) {
    return {
      is_finished: true,
      status: "error",
      targetIds: [],
      summary: "goal, tasks, or groups required",
      steps: [],
      error: "goal, tasks, or groups required",
    };
  }

  const startedAt = Date.now();
  const deadline = createDeadline(input.timeoutMs ?? config.runTimeoutMs);
  const trace = input.debug ? createTrace() : noTrace;
  if (trace.enabled) log.info(`debug trace: ${trace.path}`);
  const jev = createJevClient(config, trace);
  trace.record({ kind: "note", name: "run.start", input, plan: planned });
  const browser = await connectPlaywright(config, trace);
  const usage: UsageTotals = noUsage();
  const cwd = process.cwd();
  const allow = buildAllowlist(cwd, input.contextPaths);
  const blob = [
    input.goal,
    ...(input.tasks ?? []),
    ...(input.groups ?? []).flatMap((group) => [group.goal, ...(group.tasks ?? [])]),
  ]
    .filter(Boolean)
    .join(" ");
  const availableFiles = [
    ...(input.contextPaths ?? []),
    ...extractFindTerms(blob).filter((term) => looksLikePath(term) && existsSync(resolve(cwd, term))),
  ];
  const sharedUrls = extractUrls(blob, input.startUrl);

  try {
    const clusters = clusterByTab(planned);
    const groupRuns = (
      await Promise.all(
        clusters.map(async (series, clusterIndex) => {
          const out: Array<GroupResult & { usage: UsageTotals }> = [];
          for (const [groupIndex, group] of series.entries()) {
            out.push(
              await runGroup({
                browser,
                jev,
                config,
                input,
                group,
                availableFiles,
                sharedUrls,
                allow,
                budget: input.maxSteps ?? config.maxSteps,
                deadline,
                trace,
              }),
            );
          }
          return out;
        }),
      )
    ).flat();

    for (const group of groupRuns) mergeUsage(usage, group.usage);

    const groupResults: GroupResult[] = groupRuns.map(({ usage: _usage, ...rest }) => rest);
    // Steps and tasks live on their group. Repeating them here doubled the
    // payload, and a single cart read is thousands of characters.
    const steps = groupResults.length === 1 ? groupResults[0]!.steps : [];
    const tasks = groupResults.length === 1 ? groupResults[0]!.tasks : [];
    const targetIds = [
      ...new Set(groupResults.map((group) => group.targetId).filter((id): id is string => Boolean(id))),
    ];
    const status = rollup(groupResults);
    const summary = groupResults.map((group) => `${group.id} ${group.status}: ${group.summary}`).join(" | ");
    const first = groupResults[0];
    const checked = groupResults.filter((group) => group.verified !== undefined);
    const handoff = groupResults.find((group) => group.handoff)?.handoff;

    let snapshot: string | undefined;
    if (input.returnSnapshot && first?.targetId) {
      const snap = await browser.snapshot(first.targetId, {
        interactive: true,
        compact: true,
        maxChars: 4000,
      });
      snapshot = clip(snap.text, 4000);
    }

    return {
      is_finished: true,
      status,
      targetIds,
      groupId: first?.groupId,
      url: first?.url,
      title: first?.title,
      summary,
      tasks,
      groups: groupResults,
      steps,
      verified: checked.length ? checked.every((group) => group.verified) : undefined,
      handoff,
      snapshot,
      tracePath: trace.path,
      // Token counts and timings answer "what did that cost", which is a
      // debugging question, so they ride with the trace rather than every call.
      ...(input.debug ? { usage, elapsedMs: Date.now() - startedAt } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    return {
      is_finished: true,
      status: "error",
      targetIds: [],
      summary: message,
      steps: [],
      ...(input.debug ? { usage, elapsedMs: Date.now() - startedAt } : {}),
      error: message,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const runGroup = async (ctx: {
  browser: PlaywrightSession;
  jev: JevClient;
  config: JevConfig;
  input: RunActionInput;
  group: PlannedGroup;
  availableFiles: string[];
  sharedUrls: string[];
  allow: ReturnType<typeof buildAllowlist>;
  budget: number;
  deadline: Deadline;
  trace: Trace;
}): Promise<GroupResult & { usage: UsageTotals }> => {
  const { browser, input, group } = ctx;
  const groupStartedAt = Date.now();
  const usage: UsageTotals = noUsage();
  const steps: RunStep[] = [];
  const taskResults: TaskResult[] = [];
  let currentUrl = "";
  let currentTitle = "";
  let tabGroupId = group.groupId;
  let targetId = group.targetId;
  const fileNotes: Record<string, string> = {};

  try {
    if (!targetId) {
      if (!tabGroupId) {
        tabGroupId = await browser.createGroup(`jev-${randomBytes(3).toString("hex")}`);
      }
      targetId = await browser.newTab(tabGroupId, group.startUrl ?? ctx.sharedUrls[0]);
    }

    // A startUrl means go there, on a fresh tab or one the caller handed us.
    // Skipping it on an existing tab left the series reading whatever that
    // tab already showed, and calling it completed.
    const first = group.startUrl ?? (group.targetId ? undefined : ctx.sharedUrls[0]);
    if (first) {
      await browser.navigate(targetId, first);
      await browser.settle(targetId, 800);
      steps.push({
        step: 0,
        group: group.id,
        operation: "NAVIGATE",
        target: first,
        detail: "open start url",
      });
    } else {
      await browser.settle(targetId, 400);
    }

    for (const task of group.tasks) {
      const leftover = ctx.budget - steps.filter((row) => row.step > 0).length;
      if (leftover <= 0) {
        taskResults.push({ goal: task, status: "max_steps", summary: "no steps left" });
        break;
      }
      if (ctx.deadline.expired()) {
        taskResults.push({ goal: task, status: "max_steps", summary: "ran out of time" });
        break;
      }

      // Later steps stand on earlier ones, so a step that did not complete
      // ends the series unless the caller asked to keep going.
      const failed = taskResults.find((row) => row.status !== "completed");
      if (failed && !group.noFail) {
        taskResults.push({
          goal: task,
          status: "skipped",
          summary: `earlier step ${failed.status}: ${clip(failed.goal, 40)}`,
        });
        continue;
      }
      const taskStartedAt = Date.now();
      try {
        const outcome = await runTask({
          ...ctx,
          targetId,
          task,
          groupId: group.id,
          tabGroupId,
          motive: seriesMotive(group),
          priorResults: taskResults,
          fileNotes,
          usage,
          budget: createContextBudget(),
          deadline: ctx.deadline,
          steps,
          maxSteps: Math.min(TASK_STEPS, leftover),
          currentUrl,
          currentTitle,
        });
        currentUrl = outcome.url;
        currentTitle = outcome.title;
        // A task may have followed a link into its own tab; stay there.
        targetId = outcome.targetId;
        taskResults.push({
          goal: task,
          status: outcome.status,
          summary: outcome.summary,
          reason: outcome.reason,
          text: outcome.text,
          ...(input.debug ? { ms: Date.now() - taskStartedAt } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`task failed: ${clip(message, 120)}`);
        await browser.settle(targetId, 1500).catch(() => undefined);
        taskResults.push({
          goal: task,
          status: "error",
          summary: clip(message, 160),
          ...(input.debug ? { ms: Date.now() - taskStartedAt } : {}),
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    taskResults.push({ goal: group.tasks[taskResults.length] ?? group.id, status: "error", summary: message });
  }

  // A series that stopped early still owes the parent a row per step, so the
  // result names every step that never ran and the handoff can list them.
  const stopper = taskResults.find((row) => row.status !== "completed");
  for (const task of group.tasks.slice(taskResults.length)) {
    taskResults.push({
      goal: task,
      status: "skipped",
      summary: stopper ? `earlier step ${stopper.status}: ${clip(stopper.goal, 40)}` : "never ran",
    });
  }

  // A completed step is Jev's claim. The expected text is the evidence.
  let verified: boolean | undefined;
  let proof: string | undefined;
  let status = rollup(taskResults);
  // Proof is only worth reading when every step ran. Checking a series that
  // stopped would report the text as missing when it was never looked for.
  let proofChecked = false;
  if (group.expect) {
    // A series that asked for proof and did not get it is not verified, whether
    // the text was missing or the run never reached the page. Leaving this unset
    // made the two look like a series that never asked, and the caller's rollup
    // then read "no answer" as "passed".
    verified = false;
    if (targetId && status === "completed") {
      proofChecked = true;
      // A cart drawn by the page's own scripts arrives after the navigation, so
      // a single look can miss proof that is about to appear.
      for (let attempt = 0; attempt < 4 && !verified; attempt += 1) {
        if (attempt > 0) await browser.settle(targetId, 1500).catch(() => undefined);
        const snap = await browser.snapshot(targetId).catch(() => undefined);
        if (snap) {
          currentUrl = snap.url ?? currentUrl;
          currentTitle = snap.title ?? currentTitle;
        }
        // Read what the page shows, and fall back to the tree if that fails.
        const shown = await readPageText(browser, targetId);
        proof =
          proofContext(shown, group.expect) ??
          (snap ? proofContext(snap.text, group.expect) : undefined);
        verified = proof !== undefined;
      }
      if (!verified) status = "unverified";
    }
  }

  // A worst-case rollup reads as total failure when most steps worked, so
  // lead with the tally and hand the counts back as data.
  const counts = taskResults.reduce<Partial<Record<RunStatus, number>>>((tally, row) => {
    tally[row.status] = (tally[row.status] ?? 0) + 1;
    return tally;
  }, {});
  const tally = Object.entries(counts)
    .map(([name, n]) => `${n} ${name}`)
    .join(", ");

  const summary = [
    tally,
    ...taskResults.map((row, index) => `${index + 1}. ${row.status}: ${row.summary}`),
    ...(group.expect && proofChecked
      ? [
          verified
            ? `proof: "${clip(group.expect, 40)}" found in "${clip(proof ?? "", 120)}"`
            : `proof: "${clip(group.expect, 40)}" missing`,
        ]
      : group.expect
        ? [`proof: not checked, the series did not finish`]
        : []),
  ].join(" | ");

  return {
    id: group.id,
    targetId,
    groupId: tabGroupId,
    status,
    summary,
    tasks: taskResults,
    counts,
    steps,
    url: currentUrl || undefined,
    title: currentTitle || undefined,
    verified,
    proof,
    ...(input.debug ? { ms: Date.now() - groupStartedAt } : {}),
    handoff:
      status === "completed"
        ? undefined
        : buildHandoff({
            group,
            taskResults,
            steps,
            status,
            targetId,
            groupId: tabGroupId,
            url: currentUrl,
            title: currentTitle,
          }),
    usage,
  };
};

/** What a stopped series leaves the parent: the live tab and what is left to do. */
const buildHandoff = (ctx: {
  group: PlannedGroup;
  taskResults: TaskResult[];
  steps: RunStep[];
  status: RunStatus;
  targetId?: string;
  groupId?: string;
  url: string;
  title: string;
}): Handoff => {
  const index = ctx.taskResults.findIndex((row) => row.status !== "completed");
  const stopped = index >= 0 ? ctx.taskResults[index]! : undefined;
  const remaining = index >= 0 ? ctx.group.tasks.slice(index + 1) : [];
  return {
    resumable: Boolean(ctx.targetId) && ctx.status !== "error",
    targetId: ctx.targetId,
    groupId: ctx.groupId,
    url: ctx.url || undefined,
    title: ctx.title || undefined,
    stoppedAt: stopped?.goal ?? ctx.group.tasks.at(-1) ?? ctx.group.id,
    status: ctx.status,
    reason: stopped?.reason,
    remaining,
    recent: ctx.steps.slice(-4),
  };
};

const runTask = async (ctx: {
  browser: PlaywrightSession;
  jev: JevClient;
  config: JevConfig;
  input: RunActionInput;
  targetId: string;
  task: string;
  /** Label for this series, used in steps and traces. */
  groupId: string;
  /** The browser's own tab group. Scopes every tab lookup to this series. */
  tabGroupId?: string;
  /** Why this series exists: group goal or the planned task list. */
  motive: string;
  /** Outcomes of earlier tasks in this series. Empty on the first task. */
  priorResults: TaskResult[];
  availableFiles: string[];
  sharedUrls: string[];
  allow: ReturnType<typeof buildAllowlist>;
  fileNotes: Record<string, string>;
  usage: UsageTotals;
  budget: ContextBudget;
  deadline: Deadline;
  trace: Trace;
  steps: RunStep[];
  maxSteps: number;
  currentUrl: string;
  currentTitle: string;
}): Promise<{
  status: RunStatus;
  summary: string;
  reason?: BlockReason;
  /** What a read step found. */
  text?: string;
  url: string;
  title: string;
  targetId: string;
}> => {
  const { browser, jev, config, task } = ctx;
  let targetId = ctx.targetId;
  const intent = parseIntent(task);
  const actionLabels = intent.actionLabels;
  const values = extractValueCandidates(task, ctx.input.values);
  const usedValues = new Set<string>();
  const urls = extractUrls(task, undefined).length ? extractUrls(task) : ctx.sharedUrls;
  const needAction = actionLabels.length > 0;
  let acted = false;
  let typed = false;
  let consecutiveWaits = 0;
  let lastSig = "";
  let repeats = 0;
  let currentUrl = ctx.currentUrl;
  let currentTitle = ctx.currentTitle;
  // Refs that failed once are stale; stop offering them.
  const deadRefs = new Set<string>();
  let retries = 0;
  const taskDeadline = createDeadline(Math.min(config.taskTimeoutMs, ctx.deadline.left()));

  try {
    // Task boundaries make the isolation visible in the trace.
  ctx.trace.record({
    kind: "note",
    name: "task.start",
    group: ctx.groupId,
    task,
    intent,
    values,
    startUrl: ctx.currentUrl,
    maxSteps: ctx.maxSteps,
  });

  const prepared = await prepareTask({
      browser,
      targetId,
      task,
      intent,
      currentUrl,
      currentTitle,
      groupId: ctx.groupId,
      steps: ctx.steps,
    });
    currentUrl = prepared.url;
    currentTitle = prepared.title;
    typed = prepared.typed;
    // A read step asks nothing of Jev. It hands the page's words back so the
    // caller can check the outcome without reaching for another tool.
    if (intent.kind === "read") {
      await browser.settle(targetId, 1200);
      // "read the page title and url" answers "where am I" without paying for
      // a whole page of text, which is the cheap check between steps.
      if (/\b(url|address|title|where)\b/i.test(task)) {
        const at = await browser.where(targetId);
        return {
          status: at.url ? "completed" : "rejected",
          summary: at.url ? `${clip(at.title || "(no title)", 60)} at ${shortUrl(at.url)}` : "the page gave no address",
          reason: at.url ? undefined : "not_ready",
          text: JSON.stringify(at),
          url: at.url || currentUrl,
          title: at.title || currentTitle,
          targetId,
        };
      }
      const shown = await readPageText(browser, targetId);
      const after = await browser.snapshot(targetId).catch(() => undefined);
      return {
        status: shown ? "completed" : "rejected",
        summary: shown ? `read ${shown.length} characters` : "the page gave no text",
        reason: shown ? undefined : "not_ready",
        text: shown ? clip(shown, READ_CAP) : undefined,
        url: after?.url ?? currentUrl,
        title: after?.title ?? currentTitle,
        targetId,
      };
    }
    // A repeat step presses the same control until the page stops offering it.
    if (intent.kind === "repeat") {
      const outcome = await pressUntilGone(browser, targetId, actionLabels);
      ctx.steps.push({
        step: ctx.steps.filter((row) => row.step > 0).length + 1,
        group: ctx.groupId,
        task,
        operation: "CLICK",
        detail: `harness ${outcome.detail}`,
      });
      const after = await browser.snapshot(targetId).catch(() => undefined);
      // Pressing nothing is the page's answer, the same answer a single press
      // gives, so it reads the same way. A cart page that shows its items as a
      // summary with no delete beside them lands here, and calling that done
      // would report an untouched cart as cleared.
      if (outcome.pressed === 0) {
        return {
          status: "rejected",
          summary: `no control on this page does "${clip(actionLabels[0] ?? task, 40)}"`,
          reason: "no_control",
          url: after?.url ?? currentUrl,
          title: after?.title ?? currentTitle,
          targetId,
        };
      }
      // Giving up with controls still on the page is not a cleared cart.
      const done = outcome.left === 0;
      return {
        status: done ? "completed" : "partial",
        summary: done
          ? `pressed ${outcome.pressed}, none left`
          : `pressed ${outcome.pressed}, ${outcome.left < 0 ? "more" : outcome.left} still there`,
        url: after?.url ?? currentUrl,
        title: after?.title ?? currentTitle,
        targetId,
      };
    }
    // A search step is done once the page answered the query.
    if (intent.kind === "search" && prepared.typed) {
      const after = await browser.snapshot(targetId).catch(() => undefined);
      return {
        status: "completed",
        summary: `searched ${intent.query}`,
        url: after?.url ?? currentUrl,
        title: after?.title ?? currentTitle,
        targetId,
      };
    }
  } catch (error) {
    log.warn(`prepare failed: ${clip(String(error), 120)}`);
    await browser.settle(targetId, 800).catch(() => undefined);
  }

  for (let step = 1; step <= ctx.maxSteps; step += 1) {
    if (ctx.deadline.expired() || taskDeadline.expired()) {
      return { status: "max_steps", summary: "timed out", url: currentUrl, title: currentTitle, targetId };
    }
    const snap = await browser.snapshot(targetId);
    // A role snapshot carries no address, so without this the page Jev is
    // told about stays whichever one the harness last navigated to by hand.
    // It then reads "add to cart" offered on a cart page and answers none.
    const here = snap.url ? { url: snap.url, title: snap.title ?? "" } : await browser.where(targetId);
    currentUrl = here.url || currentUrl;
    currentTitle = here.title || currentTitle;
    if (intent.kind === "goto" && reachedDestination(currentUrl, currentTitle, intent.destination)) {
      return {
        status: "completed",
        summary: `reached ${intent.destination}`,
        url: currentUrl,
        title: currentTitle,
        targetId,
      };
    }
    const hints = [intent.subject, ...values.map((row) => row.text)].filter(Boolean);
    // Operations inside one task stay scoped to that task; prior tasks in the
    // series land in motive/steps_done so Jev can refuse a redundant step.
    const taskSteps = ctx.steps.filter((row) => row.task === task);
    const lastOp = taskSteps.at(-1)?.operation;
    const lastFailed = Boolean(taskSteps.at(-1)?.detail?.startsWith("failed"));
    const visible = snap.elements.filter(
      (el) => !isNoise(el) && !el.disabled && !deadRefs.has(el.ref),
    );
    const stepsDone = formatStepsDone(ctx.priorResults);
    const decisionContext = {
      motive: ctx.motive,
      steps_done: stepsDone || null,
      current_task: task,
    };

    // A password, a one-time code, or a captcha is the parent's call, never
    // this server's. The tab stays open, so the parent can finish it there.
    const demand = secretDemand(visible);
    if (demand) {
      return {
        status: "blocked",
        summary: `the page asks for ${demand === "captcha" ? "a human check" : "a secret"}`,
        reason: demand,
        url: currentUrl,
        title: currentTitle,
        targetId,
      };
    }

    const actionButtons = visible.filter(
      (el) => isClickable(el) && matchesActionLabel(el.name, actionLabels),
    );
    // Only a step that asks for an entry picks one. A product page carries
    // recommendation rails whose tiles each have their own Add button, so
    // "many buttons plus many links" reads as a list and a press step would
    // wander off to whichever product Jev picked out of the rail.
    const onList = intent.kind === "pick";

    // An article that already names the subject is not a list of results.
    // Offering its content links turns "open the result" into a wrong click.
    if (intent.kind === "pick") {
      const subject = intent.subject || "";
      const onSubjectPage =
        Boolean(subject) &&
        mentions(currentTitle, subject) &&
        !looksLikeSearchResults(currentUrl, currentTitle);
      const entries = onSubjectPage ? [] : resultCandidates(visible, [subject].filter(Boolean));
      if (onSubjectPage || !entries.length) {
        return {
          status: "rejected",
          summary: onSubjectPage
            ? `this page is not a list of results for "${clip(subject || task, 40)}"`
            : `no entry on this page matches "${clip(subject || task, 40)}"`,
          reason: "no_match",
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
    }

    // The task named a button. The harness finds every control carrying those
    // words; which one is really it stays a judgment, so Jev picks.
    if (needAction && !acted && !onList) {
      const candidates = await findLabelCandidates(
        browser,
        targetId,
        actionButtons,
        actionLabels,
        snap.elements,
      );
      const button = await pickControl({
        jev,
        config,
        task,
        candidates,
        url: currentUrl,
        title: currentTitle,
        motive: ctx.motive,
        stepsDone,
        deadline: ctx.deadline,
        trace: ctx.trace,
        usage: ctx.usage,
      });
      if (button) {
        const outcome = await clickStable(browser, targetId, button);
        ctx.steps.push({
          step: ctx.steps.filter((row) => row.step > 0).length + 1,
          group: ctx.groupId,
          task,
          operation: "CLICK",
          target: shortRef(button.ref),
          detail: `harness ${clip(outcome.detail, 80)} (${clip(button.name, 24)})`,
        });
        if (outcome.ok) {
          await browser.settle(targetId, 2200);
          acted = true;
          return {
            status: "completed",
            summary: `pressed ${clip(button.name, 32)}`,
            url: currentUrl,
            title: currentTitle,
            targetId,
          };
        }
        deadRefs.add(button.ref);
        continue;
      }
      // The named control is not here. Ask why before trying anything else.
      const why = await askWhyBlocked({
        jev,
        config,
        task,
        deadline: ctx.deadline,
        trace: ctx.trace,
        usage: ctx.usage,
        state: JSON.stringify({
          ...decisionContext,
          wanted: intent.subject || null,
          page_url: shortUrl(currentUrl),
          page_title: clip(currentTitle, 60),
          page_elements: elementTable(prioritize(visible, 36, hints), 36),
        }),
      });
      if (why.blocked > 0.6 && why.reason !== "not_ready") {
        return {
          status: HANDS_BACK.has(why.reason) ? "blocked" : "rejected",
          summary: `${REJECTION[why.reason] ?? why.reason} (noul=${why.blocked.toFixed(2)})`,
          reason: why.reason,
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
      if (intent.query && retries < 2) {
        retries += 1;
        const again = await searchOnPage(browser, targetId, intent.query);
        ctx.steps.push({
          step: ctx.steps.filter((row) => row.step > 0).length + 1,
          group: ctx.groupId,
          task,
          operation: "TYPE_TEXT",
          detail: `harness searched again: ${again.detail}`,
        });
        if (again.ok) continue;
      }
      // Fall through with noClick so scroll/wait can reveal the control, but
      // nothing else on the page can be pressed in its place.
    }
    // The questions carry every ref and label, so the state stays a few named fields.
    // https://docs.typesafe.ai/concepts/state
    const buildLive = (rows: typeof snap.elements): string =>
      JSON.stringify({
        ...decisionContext,
        wanted: intent.subject || null,
        page_url: shortUrl(currentUrl),
        page_title: clip(currentTitle, 60),
        page_elements: elementTable(rows, rows.length),
      });

    // On a list of results the one judgment is which entry matches the subject.
    const entries = onList ? resultCandidates(visible, hints) : [];
    // A pick chooses among entries. Handing it the whole page instead turns
    // "open the result" into "click anything", which is how a footer link and
    // a filter facet came back as results.
    const pool = entries.length ? entries : intent.kind === "pick" ? [] : visible;
    if (intent.kind === "pick" && !pool.length) {
      return {
        status: "rejected",
        summary: `no entry on this page matches "${clip(intent.subject || task, 40)}"`,
        reason: "no_match",
        url: currentUrl,
        title: currentTitle,
        targetId,
      };
    }
    // Only force a click when the page really offers choices and the last one worked.
    const mustChoose = !lastFailed && entries.length >= 2;

    // Search with no field and no way to reveal one is a missing control.
    if (intent.kind === "search" && !typed) {
      const hasType = visible.some((el) => el.role === "searchbox" || el.role === "textbox");
      if (!hasType) {
        const again = await searchOnPage(browser, targetId, intent.query ?? intent.subject);
        ctx.steps.push({
          step: ctx.steps.filter((row) => row.step > 0).length + 1,
          group: ctx.groupId,
          task,
          operation: "TYPE_TEXT",
          detail: `harness ${again.detail}`,
        });
        if (again.ok) {
          typed = true;
          const after = await browser.snapshot(targetId).catch(() => undefined);
          return {
            status: "completed",
            summary: `searched ${intent.query ?? intent.subject}`,
            url: after?.url ?? currentUrl,
            title: after?.title ?? currentTitle,
            targetId,
          };
        }
        return {
          status: "rejected",
          summary: `no search box on this page`,
          reason: "no_control",
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
    }

    let elements = prioritize(pool, ctx.budget.elementLimit(), hints, {
      hideSearch: typed,
    });
    let questions = {} as ReturnType<typeof buildQuestions>;
    let state = "";
    for (const limit of [ctx.budget.elementLimit(), 24, 16, 10, 6]) {
      elements = prioritize(pool, limit, hints, { hideSearch: typed });
      const space = buildActionSpace(elements, {
        urls,
        values: values.filter((row) => !usedValues.has(row.id)),
        files: ctx.availableFiles.filter((path) => !ctx.fileNotes[path]),
        findTerms: [],
      });
      const ops = availableOperations(space, pageLooksEmpty(currentUrl, currentTitle), lastOp, {
        // Typing stays available whenever nothing has been typed yet, so a
        // failed harness search can still be finished by Jev.
        allowType: !typed,
        allowNavigate: Boolean(intent.destination),
        clickOnly: mustChoose,
        // A step that named a control stays on its page. Scrolling and
        // waiting can still reveal that control; clicking elsewhere cannot.
        noClick: needAction && !onList,
      });
      questions = buildQuestions(space, ops, task, visible);
      // Old pages are droppable. The live page is pinned.
      // Only the live snapshot goes to Jev. A stale page is a distractor.
      state = ctx.budget.fit([{ text: clip(buildLive(elements), STATE_CAP), pin: true }], questions);
      if (ctx.budget.fits(state, questions)) break;
    }

    const decision = await withTimeout(
      jev.decide(state as EntryType, questions),
      ctx.deadline.cap(config.callTimeoutMs),
      "jev decide",
    );
    ctx.budget.record(decision.usage.inputTokens || estimateTokens(state));
    addUsage(ctx.usage, decision.usage, "decision");
    ctx.trace.record({
      kind: "decision",
      name: `${ctx.groupId}/${task}`,
      step,
      state,
      questions,
      answers: decision.answers,
      usage: decision.usage,
    });

    // The page can be something the task was never written for. Jev says so on
    // every step; only then is it worth a second call to ask what it is.
    if (noulOf(decision.answers, "unexpected") > 0.7) {
      const why = await askWhyBlocked({
        jev,
        config,
        task,
        deadline: ctx.deadline,
        trace: ctx.trace,
        usage: ctx.usage,
        state,
      });
      if (why.blocked > 0.6 && why.reason !== "not_ready") {
        return {
          status: HANDS_BACK.has(why.reason) ? "blocked" : "rejected",
          summary: REJECTION[why.reason] ?? why.reason,
          reason: why.reason,
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
    }

    const verdict = compose(decision.answers, config, {
      step,
      maxSteps: ctx.maxSteps,
      consecutiveWaits,
      repeats,
    });

    if (verdict.kind === "finish") {
      return { status: "completed", summary: verdict.reason, url: currentUrl, title: currentTitle, targetId };
    }
    if (verdict.kind === "blocked") {
      // Looping or waiting out a named control means the control is not here.
      if (needAction && !acted) {
        return {
          status: "rejected",
          summary: `no control on this page does "${clip(actionLabels[0] ?? task, 40)}" (${verdict.reason})`,
          reason: "no_control",
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
      // Missing search box / empty decision is the page's answer, not a handoff.
      if (intent.kind === "search") {
        return {
          status: "rejected",
          summary: `no search box on this page (${verdict.reason})`,
          reason: "no_control",
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
      if (intent.kind === "pick") {
        return {
          status: "rejected",
          summary: `no entry on this page matches "${clip(intent.subject || task, 40)}" (${verdict.reason})`,
          reason: "no_match",
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
      return { status: "blocked", summary: verdict.reason, url: currentUrl, title: currentTitle, targetId };
    }

    // Standing none: refuse rather than press an unrelated control.
    if (
      verdict.operation === "CLICK" &&
      (verdict.target === NO_CONTROL || !verdict.target)
    ) {
      if (intent.kind === "pick") {
        return {
          status: "rejected",
          summary: `no entry on this page matches "${clip(intent.subject || task, 40)}"`,
          reason: "no_match",
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
      return {
        status: "rejected",
        summary: `no control on this page does "${clip(actionLabels[0] ?? task, 40)}"`,
        reason: "no_control",
        url: currentUrl,
        title: currentTitle,
        targetId,
      };
    }

    const sig = signature(verdict.operation, verdict.target);
    repeats = sig === lastSig ? repeats + 1 : 0;
    lastSig = sig;
    consecutiveWaits = verdict.operation === "WAIT" ? consecutiveWaits + 1 : 0;

    // Jev chose an entry in a list. Press that entry's own button, which keeps
    // the right item and avoids the tab its link would open.
    if (needAction && onList && intent.kind !== "pick" && verdict.operation === "CLICK" && verdict.target) {
      const entry = elements.find((el) => el.ref === verdict.target);
      const nearby =
        entry && actionNearEntry(snap.elements, entry, (name) => matchesActionLabel(name, actionLabels));
      if (entry && nearby) {
        const outcome = await clickStable(browser, targetId, nearby);
        ctx.steps.push({
          step: ctx.steps.filter((row) => row.step > 0).length + 1,
          group: ctx.groupId,
          task,
          operation: "CLICK",
          target: shortRef(nearby.ref),
          detail: `harness ${clip(outcome.detail, 80)} for ${clip(entry.name, 32)}`,
          confidence: verdict.confidence,
        });
        if (outcome.ok) {
          await browser.settle(targetId, 2500);
          acted = true;
          return {
            status: "completed",
            summary: `pressed ${clip(nearby.name, 24)} for ${clip(entry.name, 40)}`,
            url: currentUrl,
            title: currentTitle,
            targetId,
          };
        }
        deadRefs.add(nearby.ref);
        continue;
      }
    }

    const tabsBefore = verdict.operation === "CLICK" ? await browser.listTabs().catch(() => []) : [];
    const beforeClick = { url: currentUrl, title: currentTitle };
    const detail = await execute(browser, {
      targetElement: elements.find((el) => el.ref === verdict.target),
      lastClickName: elements.find((el) => el.ref === verdict.target)?.name,
      usage: ctx.usage,
      config,
      goal: task,
      targetId,
      verdict,
      values,
      usedValues,
      fileNotes: ctx.fileNotes,
      allow: ctx.allow,
      page: `${clip(currentTitle, 40)} ${shortUrl(currentUrl)}`,
      history: taskSteps
        .slice(-4)
        .map((row) => `${row.operation} ${clip(row.detail ?? row.target ?? "", 32)}`)
        .join(" | "),
    });

    ctx.steps.push({
      step: ctx.steps.filter((row) => row.step > 0).length + 1,
      group: ctx.groupId,
      task,
      operation: verdict.operation,
      target: verdict.target ? shortRef(verdict.target) : undefined,
      detail: clip(detail, 120),
      confidence: verdict.confidence,
    });
    log.info(`${ctx.groupId} ${task.slice(0, 32)} step ${step} ${verdict.operation}`, {
      target: verdict.target,
      detail,
      confidence: verdict.confidence,
    });

    const failed = detail.startsWith("failed");
    if (failed && verdict.target) deadRefs.add(verdict.target);
    const clickName = elements.find((el) => el.ref === verdict.target)?.name ?? "";
    if (!failed && verdict.operation === "TYPE_TEXT") {
      typed = true;
      if (intent.kind === "search") {
        const after = await browser.snapshot(targetId).catch(() => undefined);
        return {
          status: "completed",
          summary: `searched ${intent.query ?? intent.subject}`,
          url: after?.url ?? currentUrl,
          title: after?.title ?? currentTitle,
          targetId,
        };
      }
    }
    if (!failed && verdict.operation === "CLICK") {
      // The click may have opened its own tab; the old one never changes.
      const adopted = await followNewTab(
        browser,
        tabsBefore,
        targetId,
        currentUrl,
        ctx.tabGroupId,
      );
      if (adopted) {
        targetId = adopted;
        deadRefs.clear();
        // The run moved to another page, so stop describing the old one.
        const moved = await browser.where(adopted);
        currentUrl = moved.url || currentUrl;
        currentTitle = moved.title || currentTitle;
        ctx.steps.push({
          step: ctx.steps.filter((row) => row.step > 0).length + 1,
          group: ctx.groupId,
          task,
          operation: "NAVIGATE",
          target: adopted,
          detail: "harness followed the tab the click opened",
        });
      }
      // A pick is done once the chosen entry is actually up. Pressing
      // something is not the same as reaching it, and a click that leaves the
      // page as it was has opened nothing.
      if (intent.kind === "pick" && clickName) {
        const landed = await showsChoice(
          browser,
          targetId,
          { url: beforeClick.url, title: beforeClick.title },
          clickName,
        );
        currentUrl = landed.url;
        currentTitle = landed.title;
        if (landed.ok) {
          return {
            status: "completed",
            summary: `opened ${clip(clickName, 40)}`,
            url: currentUrl,
            title: currentTitle,
            targetId,
          };
        }
        deadRefs.add(verdict.target ?? "");
        ctx.steps.push({
          step: ctx.steps.filter((row) => row.step > 0).length + 1,
          group: ctx.groupId,
          task,
          operation: "CLICK",
          detail: `opened nothing: ${landed.why} (${clip(clickName, 32)})`,
        });
        continue;
      }
      if (matchesActionLabel(clickName, actionLabels)) {
        acted = true;
        return {
          status: "completed",
          summary: `pressed ${clip(clickName, 32)}`,
          url: currentUrl,
          title: currentTitle,
          targetId,
        };
      }
    }
  }

  // A step that named a control and never found it is the page's answer, not
  // a budget problem. Saying so beats letting the caller guess.
  if (needAction && !acted) {
    return {
      status: "rejected",
      summary: `no control on this page does "${clip(actionLabels[0] ?? task, 40)}"`,
      reason: "no_control",
      url: currentUrl,
      title: currentTitle,
      targetId,
    };
  }
  if (intent.kind === "pick") {
    return {
      status: "rejected",
      summary: `no entry on this page matches "${clip(intent.subject || task, 40)}"`,
      reason: "no_match",
      url: currentUrl,
      title: currentTitle,
      targetId,
    };
  }
  return {
    status: "max_steps",
    summary: `stopped after ${ctx.maxSteps} steps`,
    url: currentUrl,
    title: currentTitle,
    targetId,
  };
};

/**
 * Reasons the parent can still act on, because it owns the same tab. Anything
 * else is the page's own answer and ends the step.
 */
const HANDS_BACK = new Set<BlockReason>(["credentials", "captcha", "sign_in"]);

const REJECTION: Record<string, string> = {
  unavailable: "the item cannot be bought here right now",
  sign_in: "the page asks the user to sign in",
  credentials: "the page asks for a password or a one-time code",
  captcha: "the page asks the user to prove they are a human",
  wrong_page: "this page is not about the wanted thing",
  other_route: "the page only offers another route, such as other sellers",
  not_ready: "the page has not finished loading",
};

/**
 * Finding is the harness's job; choosing is Jev's. One candidate whose label
 * is the task's own words needs no judgment, so that case skips the call.
 */
const pickControl = async (ctx: {
  jev: JevClient;
  config: JevConfig;
  task: string;
  candidates: LabelCandidate[];
  url: string;
  title: string;
  motive: string;
  stepsDone: string;
  deadline: Deadline;
  trace: Trace;
  usage: UsageTotals;
}): Promise<LabelCandidate | undefined> => {
  if (!ctx.candidates.length) return undefined;
  if (ctx.candidates.length === 1 && ctx.candidates[0]!.match === "exact") {
    return ctx.candidates[0];
  }
  // The state has to hold the controls the question asks about. A control
  // drawn without a role is missing from the page's own element list, so a
  // state built from that list shows a page where the option does not exist,
  // and the honest answer to "which of these" becomes "none".
  const state = JSON.stringify({
    motive: ctx.motive,
    steps_done: ctx.stepsDone || null,
    current_task: ctx.task,
    page_url: shortUrl(ctx.url),
    page_title: clip(ctx.title, 60),
    controls: Object.fromEntries(
      ctx.candidates.map((el, index) => [controlOption(index), describeCandidate(el)]),
    ),
  });
  try {
    const questions = buildControlQuestions(ctx.task, ctx.candidates);
    const decision = await withTimeout(
      ctx.jev.decide(state as EntryType, questions),
      ctx.deadline.cap(ctx.config.callTimeoutMs),
      "jev control",
    );
    addUsage(ctx.usage, decision.usage, "decision");
    ctx.trace.record({
      kind: "decision",
      name: "control",
      state,
      questions,
      answers: decision.answers,
    });
    const choice = choiceOf(decision.answers, "control")?.choice;
    if (!choice || choice === NO_CONTROL) return undefined;
    return ctx.candidates.find((_row, index) => controlOption(index) === choice);
  } catch {
    // A failed judgment is not a licence to press the first thing found.
    return undefined;
  }
};

/** Why can the page not do this? A judgment, so Jev answers it. */
const askWhyBlocked = async (ctx: {
  jev: JevClient;
  config: JevConfig;
  task: string;
  state: string;
  deadline: Deadline;
  trace: Trace;
  usage: UsageTotals;
}): Promise<{ blocked: number; reason: BlockReason }> => {
  try {
    const questions = buildBlockerQuestions(ctx.task);
    const decision = await withTimeout(
      ctx.jev.decide(ctx.state as EntryType, questions),
      ctx.deadline.cap(ctx.config.callTimeoutMs),
      "jev blocker",
    );
    addUsage(ctx.usage, decision.usage, "decision");
    ctx.trace.record({
      kind: "decision",
      name: "blocker",
      state: ctx.state,
      questions,
      answers: decision.answers,
    });
    return {
      blocked: noulOf(decision.answers, "blocked"),
      reason: (choiceOf(decision.answers, "blocker")?.choice as BlockReason) ?? "unknown",
    };
  } catch {
    return { blocked: 0, reason: "unknown" };
  }
};

const prepareTask = async (ctx: {
  browser: PlaywrightSession;
  targetId: string;
  task: string;
  intent: TaskIntent;
  currentUrl: string;
  currentTitle: string;
  groupId: string;
  steps: RunStep[];
}): Promise<{ url: string; title: string; typed: boolean }> => {
  const { currentUrl, currentTitle, intent } = ctx;
  const record = (operation: string, target: string, detail: string) => {
    ctx.steps.push({
      step: ctx.steps.filter((row) => row.step > 0).length + 1,
      group: ctx.groupId,
      task: ctx.task,
      operation,
      target,
      detail,
    });
  };

  // A task naming an address goes there first.
  const start = extractUrls(ctx.task)[0];
  if (start) {
    await ctx.browser.navigate(ctx.targetId, start);
    await ctx.browser.settle(ctx.targetId, 1200);
    record("NAVIGATE", start, "harness opened the address in the task");
    return { url: start, title: currentTitle, typed: false };
  }

  // A step naming a place goes there by its own link, not by a click that an
  // overlay can swallow.
  if (intent.kind === "goto" && intent.destination) {
    const href = await findLinkTo(ctx.browser, ctx.targetId, intent.destination);
    if (href) {
      await ctx.browser.navigate(ctx.targetId, href);
      await ctx.browser.settle(ctx.targetId, 1800);
      record("NAVIGATE", href, `harness followed the ${intent.destination} link`);
      return { url: href, title: currentTitle, typed: false };
    }
  }

  // A step naming something to look for starts by searching this page for it.
  if (intent.query && (intent.kind === "search" || intent.kind === "press")) {
    const outcome = await searchOnPage(ctx.browser, ctx.targetId, intent.query);
    record("TYPE_TEXT", intent.query, `harness ${outcome.detail}`);
    return { url: currentUrl, title: currentTitle, typed: outcome.ok };
  }

  return { url: currentUrl, title: currentTitle, typed: false };
};

const execute = async (
  browser: PlaywrightSession,
  ctx: {
    config: JevConfig;
    goal: string;
    targetId: string;
    verdict: Extract<ReturnType<typeof compose>, { kind: "act" }>;
    values: { id: string; label: string; text: string }[];
    usedValues: Set<string>;
    fileNotes: Record<string, string>;
    allow: ReturnType<typeof buildAllowlist>;
    page: string;
    history: string;
    usage: UsageTotals;
    targetElement?: PageElement;
    lastClickName?: string;
  },
): Promise<string> => {
  const { verdict, targetId } = ctx;
  try {
    return await runOperation(browser, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await browser.settle(targetId, 800).catch(() => undefined);
    return `failed: ${clip(message, 120)}`;
  }
};

const runOperation = async (
  browser: PlaywrightSession,
  ctx: Parameters<typeof execute>[1],
): Promise<string> => {
  const { verdict, targetId } = ctx;
  switch (verdict.operation) {
    case "CLICK": {
      if (!verdict.target) return "missing click target";
      const name = ctx.lastClickName ?? "";
      // Refs go stale between the snapshot and the click, so recover by name.
      const outcome = ctx.targetElement
        ? await clickStable(browser, targetId, ctx.targetElement)
        : await browser
            .click(targetId, verdict.target)
            .then(() => ({ ok: true, detail: `clicked ${verdict.target}` }))
            .catch((error: unknown) => ({
              ok: false,
              detail: `failed: ${clip(String(error), 120)}`,
            }));
      await browser.settle(targetId, 1800);
      return `${outcome.detail}${name ? ` (${clip(name, 24)})` : ""}`;
    }
    case "TYPE_TEXT": {
      if (!verdict.target) return "missing type target";
      // This server never fills a password or a one-time code.
      if (ctx.targetElement && isSecretField(ctx.targetElement)) {
        return "failed: refused to type into a secret field";
      }
      const chosen = ctx.values.find((row) => row.id === verdict.valueId);
      let text = chosen?.text;
      if (!text || verdict.valueId === "generate") {
        const written = await generateTypeText(ctx.config, {
          goal: ctx.goal,
          field: verdict.target,
          page: ctx.page,
          history: ctx.history,
          candidates: ctx.values.map((row) => row.text),
        });
        text = written.text;
        if (written.usage) addUsage(ctx.usage, written.usage, "text");
      }
      if (!text) return "no text to type";
      if (chosen) ctx.usedValues.add(chosen.id);
      await browser.type(targetId, verdict.target, text, true);
      await browser.settle(targetId, 1800);
      return `typed ${JSON.stringify(text)}${verdict.submit ? " + enter" : ""}`;
    }
    case "SELECT":
      if (!verdict.target) return "missing select target";
      {
        const value =
          ctx.values.find((row) => row.id === verdict.valueId)?.text ?? ctx.values[0]?.text ?? "";
        if (!value) return "no select value";
        await browser.select(targetId, verdict.target, [value]);
        await browser.settle(targetId, 500);
        return `selected ${value}`;
      }
    case "SCROLL_DOWN":
      await browser.press(targetId, "PageDown");
      await browser.settle(targetId, 300);
      return "scrolled down";
    case "WAIT": {
      // A slow page needs seconds, not a settle, so Jev picks the length.
      const waitMs = verdict.waitMs ?? 2000;
      await browser.wait(targetId, waitMs).catch(() => undefined);
      return `waited ${Math.round(waitMs / 1000)}s`;
    }
    case "NAVIGATE":
      if (!verdict.target) return "missing url";
      await browser.navigate(targetId, verdict.target);
      await browser.settle(targetId, 900);
      return `opened ${verdict.target}`;
    case "READ_FILE":
      if (!verdict.target) return "missing file";
      {
        const file = readAllowedFile(verdict.target, ctx.allow);
        ctx.fileNotes[verdict.target] = file.text.slice(0, 400);
        return `read ${file.path}${file.truncated ? " (truncated)" : ""}`;
      }
    case "PRESS_ENTER":
      await browser.press(targetId, "Enter");
      await browser.settle(targetId, 1100);
      return "pressed enter";
    default:
      return `unhandled ${verdict.operation}`;
  }
};
