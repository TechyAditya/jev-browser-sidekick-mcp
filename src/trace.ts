import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { USER_DIR } from "./config.js";

export interface TraceEntry {
  at: string;
  kind: "tool" | "decision" | "step" | "note";
  name: string;
  ms?: number;
  ok?: boolean;
  [field: string]: unknown;
}

export interface Trace {
  enabled: boolean;
  path?: string;
  record(entry: Omit<TraceEntry, "at">): void;
}

export const noTrace: Trace = { enabled: false, record: () => undefined };

export const defaultTracePath = (): string =>
  join(USER_DIR, "traces", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

/** Debug runs keep every Playwright call and Jev answer, untruncated. */
export const createTrace = (path = defaultTracePath()): Trace => {
  mkdirSync(dirname(path), { recursive: true });
  return {
    enabled: true,
    path,
    record(entry) {
      const row: Record<string, unknown> = { ...entry, at: new Date().toISOString() };
      try {
        appendFileSync(path, `${JSON.stringify(row)}\n`);
      } catch {
        // A broken trace must never break the run.
      }
    },
  };
};
