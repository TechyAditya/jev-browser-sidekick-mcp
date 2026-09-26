#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { runAction } from "./loop.js";
import { startMcpServer } from "./mcp.js";
import { connectPlaywright } from "./playwright.js";
import { runSetup, type SetupOptions } from "./setup.js";
import type { Provider, TaskGroupSpec } from "./types.js";

const HELP = `jev-bro, the browser sidekick. You write the steps, Jev picks the controls.

setup
  Write OPENROUTER_API_KEY or TYPESAFE_API_KEY to ~/.jev/.env.
  --provider openrouter
  --provider official
  --api-key KEY
  --text-key KEY
  --install-cursor
  --project-env

doctor
  Call Jev once. Open one agentic-playwright-mcp tab.

mcp
  Serve run_action on stdio.
  --debug              Trace every run, whatever the caller passes.

run [goal]
  Run one goal, or --task series, or --groups-json parallel groups.
  --target-id ID
  --group-id ID
  --start-url URL
  --task TEXT          Repeatable. Serial tasks on one tab.
  --groups-json JSON   Array of {id, targetId, tasks, goal}.
  --max-steps N
  --timeout-ms N       Ceiling for the whole run. Default 300000.
  --expect TEXT        Proof text. The run is unverified without it on the page.
  --no-fail            Keep going after a step that did not complete.
  --debug              Keep every Playwright call and Jev answer in ~/.jev/traces.
  --snapshot           Include the final page's accessibility tree.
`;

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/** Flush stdout, then leave. A stray child handle must not hold the CLI open. */
const exitNow = async (code: number): Promise<never> => {
  await new Promise<void>((resolve) => {
    if (process.stdout.write("")) resolve();
    else process.stdout.once("drain", () => resolve());
    setTimeout(resolve, 300).unref();
  });
  process.exit(code);
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      "api-key": { type: "string" },
      "text-key": { type: "string" },
      "install-cursor": { type: "boolean", default: false },
      "project-env": { type: "boolean", default: false },
      "target-id": { type: "string" },
      "group-id": { type: "string" },
      "start-url": { type: "string" },
      task: { type: "string", multiple: true },
      "groups-json": { type: "string" },
      "max-steps": { type: "string" },
      "timeout-ms": { type: "string" },
      expect: { type: "string" },
      "no-fail": { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      snapshot: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const command = positionals[0];
  if (!command) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "setup") {
    const provider = values.provider as Provider | undefined;
    const options: SetupOptions = {
      provider,
      apiKey: values["api-key"],
      textKey: values["text-key"],
      installCursor: values["install-cursor"],
      projectEnv: values["project-env"],
    };
    process.stdout.write(`${await runSetup(options)}\n`);
    return;
  }

  if (command === "doctor") {
    process.stdout.write(`${await runDoctor()}\n`);
    return;
  }

  if (command === "mcp") {
    await startMcpServer({ debug: values.debug });
    return;
  }

  if (command === "run") {
    const goal = positionals.slice(1).join(" ").trim();
    const tasks = values.task;
    let groups: TaskGroupSpec[] | undefined;
    if (values["groups-json"]) {
      groups = JSON.parse(values["groups-json"]) as TaskGroupSpec[];
    }
    if (!goal && !tasks?.length && !groups?.length) {
      fail("jev run requires a goal, --task, or --groups-json.");
    }
    const result = await runAction(
      {
        goal: goal || undefined,
        tasks,
        groups,
        targetId: values["target-id"],
        groupId: values["group-id"],
        startUrl: values["start-url"],
        maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
        timeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined,
        expect: values.expect,
        noFail: values["no-fail"],
        debug: values.debug,
        returnSnapshot: values.snapshot,
      },
      loadConfig(),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    await exitNow(result.status === "error" ? 1 : 0);
  }

  fail(`Unknown command: ${command}\n\n${HELP}`);
};

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
