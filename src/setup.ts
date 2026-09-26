import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  OPENROUTER_BASE,
  USER_CONFIG,
  USER_DIR,
  USER_ENV,
  ensureUserDir,
} from "./config.js";
import type { Provider } from "./types.js";

export interface SetupOptions {
  provider?: Provider;
  apiKey?: string;
  textKey?: string;
  installCursor?: boolean;
  projectEnv?: boolean;
}

const ask = async (
  rl: ReturnType<typeof createInterface>,
  question: string,
  fallback?: string,
): Promise<string> => {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback || "";
};

const envLine = (key: string, value: string): string =>
  `${key}=${value.replace(/\r?\n/g, "")}`;

const writeEnvFile = (
  path: string,
  values: Record<string, string>,
): void => {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const map = new Map<string, string>();
  for (const line of existing.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) map.set(match[1], match[2]);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value) map.set(key, value);
  }
  const body = [...map.entries()].map(([k, v]) => envLine(k, v)).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600 });
};

const mergeCursorMcp = (): string => {
  const file = join(homedir(), ".cursor", "mcp.json");

  let current: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, "utf8")) as typeof current;
    } catch {
      current = {};
    }
  }
  current.mcpServers ??= {};
  // npx rather than this copy's own path, so the entry survives a reinstall.
  current.mcpServers.jev = {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", "jev-browser-sidekick-mcp"],
  };
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  return file;
};

export const runSetup = async (options: SetupOptions = {}): Promise<string> => {
  ensureUserDir();
  const interactive = !options.provider || !options.apiKey;
  const rl = interactive
    ? createInterface({ input, output })
    : undefined;

  try {
    const provider =
      options.provider ??
      ((await rl?.question("Provider. Type openrouter or official [openrouter]: "))
        ?.trim()
        .toLowerCase() as Provider | undefined) ??
      "openrouter";

    if (provider !== "official" && provider !== "openrouter") {
      throw new Error("Provider must be `official` or `openrouter`.");
    }

    const prompt =
      provider === "official"
        ? "TypeSafe API key (TYPESAFE_API_KEY)"
        : "OpenRouter API key (OPENROUTER_API_KEY)";

    const apiKey =
      options.apiKey ?? (rl ? await ask(rl, prompt) : "");
    if (!apiKey) throw new Error("An API key is required.");

    let textKey = options.textKey;
    if (provider === "official" && rl && textKey === undefined) {
      textKey = await ask(
        rl,
        "OpenRouter key for TYPE_TEXT. Leave blank to skip.",
      );
    }

    const model = provider === "openrouter" ? "jev-1.13" : "jev-latest";
    const envValues: Record<string, string> = {
      JEV_PROVIDER: provider,
      TYPESAFE_DEFAULT_MODEL: model,
      JEV_TEXT_MODEL: "inception/mercury-2.5",
    };

    if (provider === "openrouter") {
      envValues.OPENROUTER_API_KEY = apiKey;
      envValues.TYPESAFE_API_KEY = apiKey;
      envValues.TYPESAFE_BASE_URL = OPENROUTER_BASE;
    } else {
      envValues.TYPESAFE_API_KEY = apiKey;
      if (textKey) envValues.OPENROUTER_API_KEY = textKey;
    }

    writeEnvFile(USER_ENV, envValues);
    writeFileSync(
      USER_CONFIG,
      `${JSON.stringify(
        {
          provider,
          model,
          textModel: "inception/mercury-2.5",
          playwright: {
            command: process.platform === "win32" ? "npx.cmd" : "npx",
            args: ["--yes", "agentic-playwright-mcp"],
          },
        },
        null,
        2,
      )}\n`,
    );

    if (options.projectEnv) {
      writeEnvFile(`${process.cwd()}/.env`, envValues);
    }

    let extra = "";
    const shouldInstall =
      options.installCursor === true ||
      (options.installCursor === undefined &&
        rl &&
        (await ask(rl, "Write jev into ~/.cursor/mcp.json? (y/N)", "n"))
          .toLowerCase()
          .startsWith("y"));

    if (shouldInstall) {
      const installed = mergeCursorMcp();
      extra = `\nWrote the jev server entry to ${installed}.`;
    }

    return `Wrote the ${provider} key to ${USER_DIR}.${extra}`;
  } finally {
    rl?.close();
  }
};
