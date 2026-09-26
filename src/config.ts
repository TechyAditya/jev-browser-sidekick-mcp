import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseEnv } from "dotenv";
import type { JevConfig, Provider } from "./types.js";

export const USER_DIR = join(homedir(), ".jev");
export const USER_ENV = join(USER_DIR, ".env");
export const USER_CONFIG = join(USER_DIR, "config.json");

export const OFFICIAL_BASE = "https://api.typesafe.ai";
export const OPENROUTER_BASE = "https://openrouter.ai/api";
export const DEFAULT_CDP = "http://127.0.0.1:9223";

export const ensureUserDir = (): string => {
  mkdirSync(USER_DIR, { recursive: true });
  return USER_DIR;
};

const parseProvider = (value: string | undefined): Provider | undefined => {
  if (value === "official" || value === "openrouter") return value;
  return undefined;
};

const readJson = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const num = (value: unknown, fallback: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** A global install starts in a second; the npx hop can take half a minute. */
const globalPlaywrightEntry = (): string | undefined => {
  const roots = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : undefined,
    join(homedir(), ".npm-global", "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ].filter((row): row is string => Boolean(row));
  for (const root of roots) {
    const entry = join(root, "agentic-playwright-mcp", "dist", "cli.js");
    if (existsSync(entry)) return entry;
  }
  return undefined;
};

const playwrightCommand = (): { command: string; args: string[] } => {
  const fromEnv = str(process.env.JEV_PLAYWRIGHT_COMMAND);
  if (fromEnv) {
    const parts = fromEnv.split(/\s+/).filter(Boolean);
    return { command: parts[0] ?? fromEnv, args: parts.slice(1) };
  }
  const entry = globalPlaywrightEntry();
  if (entry) return { command: process.execPath, args: [entry] };
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  return { command, args: ["--yes", "agentic-playwright-mcp"] };
};

const applyEnvFile = (path: string, locked: Set<string>): void => {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path));
  for (const [key, value] of Object.entries(parsed)) {
    if (!value?.trim() || locked.has(key)) continue;
    process.env[key] = value;
  }
};

/** Read process env, then project .env, then ~/.jev/.env, then ~/.jev/config.json. Empty file values do not replace a set key. */
export const loadConfig = (cwd = process.cwd()): JevConfig => {
  const file = readJson(USER_CONFIG);
  const locked = new Set(
    Object.entries(process.env)
      .filter(([, value]) => value?.trim())
      .map(([key]) => key),
  );
  applyEnvFile(USER_ENV, locked);
  applyEnvFile(resolve(cwd, ".env"), locked);

  const provider =
    parseProvider(process.env.JEV_PROVIDER) ??
    parseProvider(str(file.provider)) ??
    (process.env.TYPESAFE_API_KEY && !process.env.OPENROUTER_API_KEY
      ? "official"
      : "openrouter");

  const openrouterKey = str(process.env.OPENROUTER_API_KEY) ?? str(file.openrouterApiKey);
  const officialKey = str(process.env.TYPESAFE_API_KEY) ?? str(file.typesafeApiKey);

  const apiKey =
    provider === "official"
      ? officialKey ?? openrouterKey
      : openrouterKey ?? officialKey;

  const baseUrl =
    str(process.env.TYPESAFE_BASE_URL) ??
    str(file.baseUrl) ??
    (provider === "openrouter" ? OPENROUTER_BASE : OFFICIAL_BASE);

  const model =
    str(process.env.TYPESAFE_DEFAULT_MODEL) ??
    str(process.env.JEV_MODEL) ??
    str(file.model) ??
    (provider === "openrouter" ? "jev-1.13" : "jev-latest");

  const { command, args } = playwrightCommand();
  const cdp =
    str(process.env.JEV_PLAYWRIGHT_CDP) ??
    str(file.cdpEndpoint) ??
    DEFAULT_CDP;

  const thresholds = (file.thresholds ?? {}) as Record<string, unknown>;

  return {
    provider,
    apiKey: apiKey ?? "",
    baseUrl,
    model,
    openrouterApiKey: openrouterKey,
    textModel:
      str(process.env.JEV_TEXT_MODEL) ??
      str(file.textModel) ??
      "inception/mercury-2.5",
    maxSteps: num(process.env.JEV_MAX_STEPS ?? file.maxSteps, 40),
    loadTimeoutMs: num(process.env.JEV_LOAD_TIMEOUT_MS ?? file.loadTimeoutMs, 8000),
    callTimeoutMs: num(process.env.JEV_CALL_TIMEOUT_MS ?? file.callTimeoutMs, 20_000),
    taskTimeoutMs: num(process.env.JEV_TASK_TIMEOUT_MS ?? file.taskTimeoutMs, 90_000),
    // An MCP client drops a call long before this would fire, and a dropped
    // call is worse than a short one: the browser work lands and the caller
    // never learns it did, so it repeats the work. Return first, resume after.
    runTimeoutMs: num(process.env.JEV_RUN_TIMEOUT_MS ?? file.runTimeoutMs, 90_000),
    playwright: { command, args, cdpEndpoint: cdp },
    thresholds: {
      complete: num(thresholds.complete, 0.85),
      looping: num(thresholds.looping, 0.7),
      blocked: num(thresholds.blocked, 0.75),
      minConfidence: num(thresholds.minConfidence, 0.32),
    },
  };
};

export const requireApiKey = (config: JevConfig): void => {
  if (config.apiKey) return;
  const hint =
    config.provider === "official"
      ? "Set TYPESAFE_API_KEY or run `jev setup --provider official`."
      : "Set OPENROUTER_API_KEY or run `jev setup --provider openrouter`.";
  throw new Error(`Jev API key is missing. ${hint}`);
};
