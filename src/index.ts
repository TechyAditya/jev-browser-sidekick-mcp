#!/usr/bin/env node
import { startMcpServer } from "./mcp.js";

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[jev] unhandledRejection ${String(reason)}\n`);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`[jev] uncaughtException ${error.message}\n`);
});

// npx resolves a package name, never a bin name, so this entry is the only one
// `npx jev-browser-sidekick-mcp` can reach. It answers for the CLI too. A bare
// call, which is what an MCP host makes, serves stdio.
const CLI_COMMANDS = new Set(["setup", "doctor", "run", "mcp", "help", "--help", "-h"]);
const first = process.argv[2];

if (first !== undefined && CLI_COMMANDS.has(first)) {
  void import("./cli.js");
} else {
  startMcpServer({ debug: process.argv.includes("--debug") }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[jev] ${message}\n`);
    process.exit(1);
  });
}
