import type { TaskStep } from "./types.js";

const URL_RE = /https?:\/\/[^\s,;]+/gi;
const DOMAIN_RE = /(?:^|[\s,;])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[\s,;]|$)/gi;
const QUOTE_RE = /["“]([^"”]{1,120})["”]/g;

const STOP = new Set([
  "open",
  "add",
  "to",
  "the",
  "a",
  "an",
  "and",
  "then",
  "cart",
  "checkout",
  "page",
  "bring",
  "them",
  "their",
  "this",
  "that",
  "with",
  "from",
  "into",
  "onto",
  "for",
  "of",
]);

export const extractUrls = (goal: string, startUrl?: string): string[] => {
  const found = new Set<string>();
  if (startUrl) found.add(normalizeUrl(startUrl));
  for (const match of goal.match(URL_RE) ?? []) {
    found.add(normalizeUrl(match.replace(/[),.;]+$/, "")));
  }
  for (const match of goal.matchAll(DOMAIN_RE)) {
    const host = match[1];
    if (host && !host.includes("@")) found.add(normalizeUrl(host));
  }
  return [...found];
};

export const normalizeUrl = (value: string): string => {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export const extractQuoted = (goal: string): string[] => {
  const values: string[] = [];
  for (const match of goal.matchAll(QUOTE_RE)) {
    if (match[1]) values.push(match[1].trim());
  }
  return values;
};

/** Pull product-like phrases from shopping / search goals. */
export const extractItems = (goal: string): string[] => {
  const afterAdd = goal.match(
    /(?:add|buy|search|find|get|order)\s+(.+?)(?:\s+to\s+(?:the\s+)?cart|\s+to\s+checkout|\s+and\s+bring|\s+then\b|$)/i,
  );
  const chunk = afterAdd?.[1] ?? "";
  const parts = chunk
    .split(/,| and /i)
    .map((part) => part.replace(/\bto cart\b/i, "").trim())
    .filter((part) => part.length > 1 && !STOP.has(part.toLowerCase()));
  const quoted = extractQuoted(goal);
  return unique([...quoted, ...parts]);
};

export const extractValueCandidates = (
  goal: string,
  values?: Record<string, string>,
): { id: string; label: string; text: string }[] => {
  const rows: { id: string; label: string; text: string }[] = [];
  if (values) {
    for (const [label, text] of Object.entries(values)) {
      if (text) rows.push({ id: `named_${slug(label)}`, label, text });
    }
  }
  for (const [index, text] of extractItems(goal).entries()) {
    rows.push({ id: `item_${index}`, label: text, text });
  }
  return uniqueBy(rows, (row) => row.text.toLowerCase()).slice(0, 24);
};

export const extractFindTerms = (goal: string): string[] =>
  extractItems(goal).slice(0, 12);

/** Parent writes the list. A lone goal stays one task. */
export const MAX_TASKS_PER_GROUP = 24;

export const resolveTasks = (explicit?: TaskStep[], fallbackGoal?: string): TaskStep[] => {
  const listed = (explicit ?? [])
    .map((row) => (typeof row === "string" ? row.trim() : row))
    // A loop with no body runs nothing, so drop it rather than spin on it.
    .filter((row) => (typeof row === "string" ? Boolean(row) : row.loop?.tasks?.some(Boolean)));
  if (listed.length) return listed.slice(0, MAX_TASKS_PER_GROUP);
  const text = fallbackGoal?.trim();
  return text ? [text] : [];
};

export const isCheckoutTask = (task: string): boolean =>
  /checkout|open cart|go to cart|proceed to (?:buy|checkout)|place order/i.test(task) &&
  !/(?:add|buy)\s+\S.{0,80}to cart/i.test(task);

export const isAddTask = (task: string): boolean =>
  /(?:add|buy).{0,80}(?:cart|basket)|to cart/i.test(task) && !isCheckoutTask(task);

/** Deterministic search URL. Beats typing into a ref that may go stale. */
export const searchUrlFor = (url: string | undefined, query: string): string | undefined => {
  if (!url || !query) return undefined;
  try {
    const parsed = new URL(url);
    if (!/amazon\./i.test(parsed.hostname)) return undefined;
    return `${parsed.origin}/s?k=${encodeURIComponent(query)}`;
  } catch {
    return undefined;
  }
};

export const cartUrlFor = (url?: string): string | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!/amazon\./i.test(parsed.hostname)) return undefined;
    return `${parsed.origin}/gp/cart/view.html`;
  } catch {
    return undefined;
  }
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32) || "value";

const unique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
};

const uniqueBy = <T>(rows: T[], key: (row: T) => string): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
};
