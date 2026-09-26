#!/usr/bin/env node
import { startMcpServer } from "./mcp.js";

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[jev] unhandledRejection ${String(reason)}\n`);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`[jev] uncaughtException ${error.message}\n`);
});

startMcpServer({ debug: process.argv.includes("--debug") }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[jev] ${message}\n`);
  process.exit(1);
});
