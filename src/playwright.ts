import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JevConfig } from "./types.js";
import { log } from "./log.js";
import { parseSnapshot, type ParsedSnapshot } from "./snapshot.js";
import { withTimeout } from "./timeout.js";
import { noTrace, type Trace } from "./trace.js";

export interface PlaywrightSession {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  createGroup(name: string): Promise<string>;
  newTab(groupId: string, url?: string): Promise<string>;
  /** Pass a groupId to see only that group's tabs. */
  listTabs(groupId?: string): Promise<string[]>;
  /** Tabs with the address each one is showing. */
  listTabsDetailed(groupId?: string): Promise<TabInfo[]>;
  selectTab(targetId: string): Promise<string>;
  closeTab(targetId: string): Promise<string>;
  navigate(targetId: string, url: string): Promise<string>;
  /** Where this tab actually is. A role snapshot carries no address. */
  where(targetId: string): Promise<{ url: string; title: string }>;
  snapshot(targetId: string, extra?: Record<string, unknown>): Promise<ParsedSnapshot>;
  click(targetId: string, ref: string): Promise<string>;
  type(targetId: string, ref: string, text: string, submit?: boolean): Promise<string>;
  select(targetId: string, ref: string, values: string[]): Promise<string>;
  press(targetId: string, key: string): Promise<string>;
  wait(targetId: string, timeMs?: number): Promise<string>;
  settle(targetId: string, extraMs?: number, loadTimeoutMs?: number): Promise<void>;
  find(targetId: string, text: string): Promise<string>;
  close(): Promise<void>;
}

/** Marks a ref that is really a CSS selector for a control with no role. */
export const CSS_REF = "css=";

export interface TabInfo {
  targetId: string;
  url: string;
}

/**
 * browser_tabs prints a block per tab: the id, then the title, then the URL.
 * Reading the URL is what lets a group tell its own new tab from another
 * group's, because a tab opened by a click is not registered in any group.
 */
export const parseTabList = (text: string): TabInfo[] => {
  const rows: TabInfo[] = [];
  const blocks = text.split(/\n(?=\[\d+\])/);
  for (const block of blocks) {
    const id = block.match(/targetId:\s*([A-F0-9]{8,})/i)?.[1];
    if (!id) continue;
    rows.push({ targetId: id, url: block.match(/(https?:\/\/\S+)/)?.[1] ?? "" });
  }
  return rows;
};

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const toolText = (result: unknown): string => {
  const row = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const text = (row.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  if (row.isError) throw new Error(text || "Playwright tool failed");
  return text;
};

export const extractId = (text: string, key: "targetId" | "groupId"): string | undefined => {
  const patterns = [
    new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`),
    new RegExp(`${key}["'\\s:=]+([A-Za-z0-9._:-]{4,})`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
};

const cdpAlive = async (endpoint: string): Promise<boolean> => {
  try {
    const url = endpoint.replace(/\/$/, "") + "/json/version";
    const response = await fetch(url, { signal: AbortSignal.timeout(600) });
    return response.ok;
  } catch {
    return false;
  }
};

export const connectPlaywright = async (
  config: JevConfig,
  trace: Trace = noTrace,
): Promise<PlaywrightSession> => {
  const args = [...config.playwright.args];
  const cdp = config.playwright.cdpEndpoint;
  if (cdp && (await cdpAlive(cdp))) {
    args.push("--cdp-endpoint", cdp);
    log.info(`attaching agentic-playwright-mcp to ${cdp}`);
  } else {
    args.push("--keep-alive");
    log.info("starting agentic-playwright-mcp with its own Chrome");
  }

  const transport = new StdioClientTransport({
    command: config.playwright.command,
    args,
    stderr: "inherit",
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  });
  const client = new Client({ name: "jev-browser-sidekick-mcp", version: "0.1.0" });
  await withTimeout(client.connect(transport), config.callTimeoutMs, "playwright connect");

  const enqueue = (() => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn, fn);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
  })();

  let warmedUp = false;
  const timeoutFor = (name: string): number => {
    const base = config.callTimeoutMs;
    // The server starts Chrome or attaches on its first call, which is slow.
    const warmup = warmedUp ? 1 : 3;
    if (name === "browser_navigate" || name === "browser_run_code_unsafe") return base * 3;
    if (name === "browser_tabs" || name === "browser_tab_group") return base * 2;
    return base * warmup;
  };

  const call = (name: string, toolArgs: Record<string, unknown> = {}): Promise<string> =>
    enqueue(async () => {
      const started = Date.now();
      try {
        const text = await withTimeout(
          (async () => {
            const result = await client.callTool({ name, arguments: toolArgs });
            warmedUp = true;
            return toolText(result);
          })(),
          timeoutFor(name),
          name,
        );
        trace.record({ kind: "tool", name, ms: Date.now() - started, ok: true, args: toolArgs, result: text });
        return text;
      } catch (error) {
        trace.record({
          kind: "tool",
          name,
          ms: Date.now() - started,
          ok: false,
          args: toolArgs,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

  const listTabsDetailed = async (groupId?: string): Promise<TabInfo[]> =>
    parseTabList(
      await call("browser_tabs", { action: "list", ...(groupId ? { groupId } : {}) }),
    );

  return {
    client,
    call,
    async createGroup(name) {
      const text = await call("browser_tab_group", { action: "create", name, color: "cyan" });
      return extractId(text, "groupId") ?? name;
    },
    async newTab(groupId, url) {
      // Opening with a url makes the call wait for the load; navigate separately.
      const text = await call("browser_tabs", { action: "new", groupId });
      const id = extractId(text, "targetId");
      if (!id) throw new Error(`browser_tabs new did not return a targetId:\n${text}`);
      if (url) {
        await call("browser_navigate", { targetId: id, url }).catch((error: unknown) => {
          log.warn(`first navigate failed: ${String(error).slice(0, 120)}`);
        });
      }
      return id;
    },
    async listTabs(groupId) {
      const rows = await listTabsDetailed(groupId);
      return rows.map((row) => row.targetId);
    },
    listTabsDetailed,
    async selectTab(targetId) {
      return call("browser_tabs", { action: "select", targetId });
    },
    async closeTab(targetId) {
      return call("browser_tabs", { action: "close", targetId });
    },
    async navigate(targetId, url) {
      return call("browser_navigate", { targetId, url });
    },
    async where(targetId) {
      const raw = await call("browser_evaluate", {
        targetId,
        expression: "() => JSON.stringify({ url: location.href, title: document.title })",
      }).catch(() => "");
      try {
        const start = raw.indexOf("{");
        const parsed = JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1)) as {
          url?: string;
          title?: string;
        };
        return { url: parsed.url ?? "", title: parsed.title ?? "" };
      } catch {
        return { url: "", title: "" };
      }
    },
    async snapshot(targetId, extra = {}) {
      // A page mid-navigation fails ariaSnapshot; give it one more chance.
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const raw = await call("browser_snapshot", {
        targetId,
        interactive: true,
        compact: true,
        // Read the whole page. Chrome such as a 46-entry category list sits at
        // the top, so a small cap truncates the buybox away. Jev still only
        // sees the short ranked table the harness builds from this.
        maxChars: 60_000,
        ...extra,
          });
          return parseSnapshot(raw);
        } catch (error) {
          lastError = error;
          log.warn(`snapshot retry: ${String(error).slice(0, 120)}`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    async click(targetId, ref) {
      // A role-less control has no ref, so it is addressed by CSS selector.
      if (ref.startsWith(CSS_REF)) {
        return call("browser_click", { targetId, element: ref.slice(CSS_REF.length) });
      }
      return call("browser_click", { targetId, ref });
    },
    async type(targetId, ref, text, submit) {
      return call("browser_type", { targetId, ref, text, submit: Boolean(submit) });
    },
    async select(targetId, ref, values) {
      return call("browser_select_option", { targetId, ref, values });
    },
    async press(targetId, key) {
      return call("browser_press_key", { targetId, key });
    },
    async wait(targetId, timeMs = 800) {
      return call("browser_wait_for", { targetId, timeMs });
    },
    async settle(_targetId, extraMs = 700, loadTimeoutMs = config.loadTimeoutMs) {
      const cap = Math.min(Math.max(extraMs, 200), loadTimeoutMs ?? 8000);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, cap);
      });
    },
    async find(targetId, text) {
      return call("browser_find", { targetId, text });
    },
    async close() {
      await withTimeout(client.close(), 5000, "playwright close").catch(() => undefined);
      // The stdio child outlives client.close() on Windows and holds the event loop open.
      await withTimeout(transport.close(), 3000, "transport close").catch(() => undefined);
    },
  };
};
