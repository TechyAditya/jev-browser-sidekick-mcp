import { matchesActionLabel, startsWithLabel } from "./intent.js";
import { CSS_REF, hostOf, type PlaywrightSession, type TabInfo } from "./playwright.js";
import {
  isShortcutDecoy,
  isTypable,
  mentions,
  nearestTitle,
  type PageElement,
} from "./snapshot.js";

/**
 * A link may open its own tab. Adopt it, because the old tab never changes.
 * Selecting the new tab first is required before anything in it can be clicked.
 *
 * Groups run at the same time in one Chrome, and a tab opened by a click joins
 * no group, so a plain "what is new" look lets two groups both claim the same
 * tab and land one site's clicks on the other's page. The opener's own host
 * tells them apart: a click on amazon.in opens another amazon.in tab.
 */
export const followNewTab = async (
  browser: PlaywrightSession,
  before: string[],
  current: string,
  openerUrl?: string,
  tabGroupId?: string,
): Promise<string | undefined> => {
  const adopt = async (targetId: string): Promise<string> => {
    await browser.selectTab(targetId).catch(() => undefined);
    await browser.settle(targetId, 1500);
    return targetId;
  };

  // agentic-playwright-mcp 1.1.0 and later put a popup in its opener's group,
  // which answers exactly, including two groups working the same site.
  if (tabGroupId) {
    const scoped = await browser.listTabsDetailed(tabGroupId).catch(() => [] as TabInfo[]);
    const ours = scoped.filter(
      (row) => !before.includes(row.targetId) && row.targetId !== current,
    );
    if (ours.length === 1) return adopt(ours[0]!.targetId);
  }

  // Older servers leave a popup ungrouped, so fall back to the opener's host:
  // a click on amazon.in opens another amazon.in tab.
  const after = await browser.listTabsDetailed().catch(() => [] as TabInfo[]);
  const fresh = after.filter((row) => !before.includes(row.targetId) && row.targetId !== current);
  if (!fresh.length) return undefined;

  const host = hostOf(openerUrl ?? "");
  const mine = host ? fresh.filter((row) => hostOf(row.url) === host) : fresh;
  const picked = mine.length === 1 ? mine[0] : fresh.length === 1 && !host ? fresh[0] : undefined;
  return picked ? adopt(picked.targetId) : undefined;
};

/** Refs go stale the moment a page moves, but names survive a re-render. */
export const clickStable = async (
  browser: PlaywrightSession,
  targetId: string,
  element: PageElement,
): Promise<{ ok: boolean; detail: string }> => {
  try {
    await browser.click(targetId, element.ref);
    return { ok: true, detail: `clicked ${element.ref}` };
  } catch (error) {
    const first = error instanceof Error ? error.message : String(error);
    // A CSS selector does not go stale the way a ref does.
    if (element.selector) return { ok: false, detail: `failed: ${first.slice(0, 120)}` };
    // Find the same control again by role and name, then click that ref.
    const snap = await browser.snapshot(targetId).catch(() => undefined);
    const again = snap?.elements.find(
      (row) => row.role === element.role && row.name.trim() === element.name.trim() && !row.disabled,
    );
    if (!again) return { ok: false, detail: `failed: ${first.slice(0, 120)}` };
    try {
      await browser.click(targetId, again.ref);
      return { ok: true, detail: `clicked ${again.ref} after refresh` };
    } catch (retryError) {
      const second = retryError instanceof Error ? retryError.message : String(retryError);
      return { ok: false, detail: `failed: ${second.slice(0, 120)}` };
    }
  }
};

/**
 * Some sites draw controls as plain text in a div, which carries no role and
 * so gets no ref. Jev reads text only, so the harness has to find those and
 * hand them over as options addressed by CSS selector.
 */
export const findTextControls = async (
  browser: PlaywrightSession,
  targetId: string,
  labels: string[],
): Promise<PageElement[]> => {
  if (!labels.length) return [];
  const raw = await browser
    .call("browser_run_code_unsafe", {
      targetId,
      timeoutMs: 15_000,
      code: `async (page) => page.evaluate((labels) => {
  const selectorFor = (node) => {
    const parts = [];
    let el = node;
    while (el && el.nodeType === 1 && el !== document.body) {
      const parent = el.parentElement;
      if (!parent) break;
      const index = Array.prototype.indexOf.call(parent.children, el) + 1;
      parts.unshift(el.tagName.toLowerCase() + ":nth-child(" + index + ")");
      el = parent;
    }
    return parts.length ? "body > " + parts.join(" > ") : "body";
  };
  const wanted = labels.map((row) => row.toLowerCase());
  // The label must lead the text or stand as whole words. A plain substring
  // makes "Registered Office Address:" answer to the label "add".
  const carries = (lower) =>
    wanted.some((label) => {
      if (lower.startsWith(label) && !/[a-z0-9]/.test(lower.charAt(label.length))) return true;
      const escaped = label.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
      return new RegExp("\\\\b" + escaped + "\\\\b").test(lower);
    });
  const rows = [];
  for (const el of document.querySelectorAll("div,span,li,td,button,a,input")) {
    const raw = el.tagName === "INPUT" ? el.value || "" : el.innerText || "";
    const text = raw.replace(/\\s+/g, " ").trim();
    if (!text || text.length > 60) continue;
    if (!carries(text.toLowerCase())) continue;
    // Site furniture is not a control, however it is labelled.
    if (el.closest("footer,[role=contentinfo]")) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 16 || box.height < 12) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (Number(style.opacity) < 0.2) continue;
    // Do not demand a pointer cursor or a button tag. Flipkart draws its
    // "Add to cart" as a plain div with cursor:auto, and so do other sites
    // built on react-native-web. The label match is what rules out furniture.
    rows.push({
      text,
      selector: selectorFor(el),
      area: box.width * box.height,
      pointer: style.cursor === "pointer",
    });
    if (rows.length > 60) break;
  }
  return rows;
}, ${JSON.stringify(labels)})`,
    })
    .catch(() => undefined);
  if (!raw) return [];

  let rows: { text: string; selector: string; area: number; pointer: boolean }[];
  try {
    const parsed: unknown = JSON.parse(raw.slice(raw.indexOf("[")));
    rows = Array.isArray(parsed) ? (parsed as typeof rows) : [];
  } catch {
    return [];
  }

  const seen = new Set<string>();
  return rows
    // The innermost pointer element is the control; its parents merely contain it.
    .sort((a, b) => Number(b.pointer) - Number(a.pointer) || a.area - b.area)
    // One button nests inside its own wrappers, which all carry its words. They
    // are one control, so offer it once rather than asking Jev to tell copies apart.
    .filter((row) => {
      const key = row.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4)
    .map((row) => ({
      ref: `${CSS_REF}${row.selector}`,
      role: "button",
      name: row.text,
      selector: row.selector,
    }));
};

/** How a control's label lined up with the words the task used. */
export type LabelMatch = "exact" | "starts" | "words" | "text";

export interface LabelCandidate extends PageElement {
  match: LabelMatch;
  /** The title this control sits under, when the page has one. */
  near?: string;
}

const MATCH_RANK: Record<LabelMatch, number> = { exact: 0, starts: 1, words: 2, text: 3 };

/**
 * Find every control that could be the one the task named. Finding is not
 * choosing: the caller hands these to Jev, which picks one or says none fits.
 * A named control can arrive late or sit below the fold, so look, wait,
 * scroll, look, and only then read the page's role-less text.
 */
export const findLabelCandidates = async (
  browser: PlaywrightSession,
  targetId: string,
  known: PageElement[],
  labels: string[],
  /** The whole page, used to read the title each control sits under. */
  all: PageElement[] = [],
  tries = 3,
  limit = 8,
): Promise<LabelCandidate[]> => {
  if (!labels.length) return [];
  const lower = labels.map((label) => label.trim().toLowerCase());

  const gather = (rows: PageElement[], all: PageElement[]): LabelCandidate[] => {
    const usable = rows.filter((row) => !row.disabled && row.name.trim() && !isShortcutDecoy(row));
    const out: LabelCandidate[] = [];
    for (const row of usable) {
      const name = row.name.trim().toLowerCase();
      const near = nearestTitle(all, row);
      if (lower.some((label) => name === label)) out.push({ ...row, match: "exact", near });
      else if (lower.some((label) => startsWithLabel(name, label)))
        out.push({ ...row, match: "starts", near });
      else if (matchesActionLabel(row.name, labels)) out.push({ ...row, match: "words", near });
    }
    return out;
  };

  const found = new Map<string, LabelCandidate>();
  const collect = (rows: LabelCandidate[]): void => {
    for (const row of rows) if (!found.has(row.ref)) found.set(row.ref, row);
  };

  collect(gather(known, all.length ? all : known));

  for (let attempt = 0; attempt < tries && !found.size; attempt += 1) {
    await browser.settle(targetId, 1200);
    if (attempt > 0) await browser.press(targetId, "PageDown").catch(() => undefined);
    const snap = await browser.snapshot(targetId).catch(() => undefined);
    collect(gather(snap?.elements ?? [], snap?.elements ?? []));
  }

  // Nothing with a role carries this label, so look for it as plain text.
  if (!found.size) {
    const text = await findTextControls(browser, targetId, labels);
    collect(
      text
        // The page script matches loosely by design; hold it to the same rule.
        .filter((row) => matchesActionLabel(row.name, labels))
        .map((row) => ({ ...row, match: "text" as const })),
    );
  }

  return [...found.values()]
    .sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match] || a.name.length - b.name.length)
    .slice(0, limit);
};

/** Press a repeating control until the page stops offering it. */
export const pressUntilGone = async (
  browser: PlaywrightSession,
  targetId: string,
  labels: string[],
  limit = 20,
): Promise<{ pressed: number; left: number; detail: string }> => {
  const matches = (name: string): boolean => matchesActionLabel(name, labels);
  let pressed = 0;
  let stale = 0;
  let previous = Number.POSITIVE_INFINITY;
  // A cart the page draws for itself is empty at the moment it loads, and an
  // empty-looking page would end this before the first delete control exists.
  await browser.settle(targetId, 1500);
  for (let round = 0; round < limit; round += 1) {
    const before = await browser.listTabs().catch(() => [] as string[]);
    const snap = await browser.snapshot(targetId).catch(() => undefined);
    let hits = (snap?.elements ?? []).filter(
      (row) => !row.disabled && !isShortcutDecoy(row) && row.name.trim() && matches(row.name),
    );
    // A cart drawn without roles keeps its remove controls out of the
    // snapshot, so an empty list is not proof of an empty cart.
    if (!hits.length) {
      hits = (await findTextControls(browser, targetId, labels)).filter((row) =>
        matches(row.name),
      );
    }
    if (!hits.length) {
      return { pressed, left: 0, detail: pressed ? `pressed ${pressed}` : "nothing to press" };
    }

  // Pressing must remove one. If the count holds, the wrong thing is being
    // pressed, so stop instead of hammering the page. Allow a few rounds,
    // because a cart that asks "remove this item?" needs a second press to
    // confirm and the count does not move in between.
    if (hits.length >= previous) stale += 1;
    else stale = 0;
    if (stale >= 4) {
      return { pressed, left: hits.length, detail: `stopped, ${hits.length} left after ${pressed}` };
    }
    previous = hits.length;

    const outcome = await clickStable(browser, targetId, hits[0]!);
    if (!outcome.ok) return { pressed, left: hits.length, detail: outcome.detail };
    pressed += 1;
    await browser.settle(targetId, 1500);

    // A press that opened a tab did something else; close it and stay here.
    const after = await browser.listTabs().catch(() => [] as string[]);
    for (const id of after.filter((row) => !before.includes(row) && row !== targetId)) {
      await browser.closeTab(id).catch(() => undefined);
    }
  }
  return { pressed, left: -1, detail: `stopped after ${limit} rounds` };
};

/**
 * The words the page actually shows. Proof of an outcome lives in rendered
 * text such as a subtotal line, which an accessibility tree can omit.
 */
export const readPageText = async (
  browser: PlaywrightSession,
  targetId: string,
): Promise<string> => {
  const raw = await browser
    .call("browser_run_code_unsafe", {
      targetId,
      timeoutMs: 15_000,
      code: `async (page) => page.evaluate(() => document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 30000))`,
    })
    .catch(() => undefined);
  return raw ?? "";
};

/**
 * Did choosing that entry actually bring it up?
 *
 * A click can navigate the tab, open its own tab, or draw an overlay over the
 * page it was on. Only the first two change the address, so an address that
 * held still proves nothing on its own: ask whether the page now names the
 * thing that was chosen.
 */
export const showsChoice = async (
  browser: PlaywrightSession,
  targetId: string,
  before: { url: string; title: string },
  name: string,
): Promise<{ ok: boolean; url: string; title: string; why: string }> => {
  const after = await browser.where(targetId);
  const url = after.url || before.url;
  const title = after.title || before.title;
  if (after.url && after.url !== before.url) {
    return { ok: true, url, title, why: "the page changed" };
  }
  if (after.title && before.title && after.title !== before.title) {
    return { ok: true, url, title, why: "the page changed" };
  }
  // The address held still. An overlay counts, so long as it is showing the
  // chosen entry rather than leaving the page as it was.
  const shown = await readPageText(browser, targetId);
  if (mentions(shown, name)) {
    return { ok: true, url, title, why: "the page shows it" };
  }
  return { ok: false, url, title, why: "the page neither changed nor shows it" };
};

/** A control that typically reveals a collapsed search field. */
const findSearchReveal = (elements: PageElement[]): PageElement | undefined =>
  elements.find(
    (row) =>
      !row.disabled &&
      (row.role === "button" || row.role === "link") &&
      /^(search|find)$/i.test(row.name.trim()),
  ) ??
  elements.find(
    (row) =>
      !row.disabled &&
      row.role === "button" &&
      /^search\b/i.test(row.name.trim()) &&
      row.name.trim().length < 24,
  );

/** Type a query into the page's own search box. Works without site knowledge. */
export const searchOnPage = async (
  browser: PlaywrightSession,
  targetId: string,
  query: string,
): Promise<{ ok: boolean; detail: string; ref?: string }> => {
  let revealed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snap = await browser.snapshot(targetId).catch(() => undefined);
    const box =
      snap?.elements.find((row) => row.role === "searchbox" && !row.disabled) ??
      snap?.elements.find((row) => isTypable(row) && !isShortcutDecoy(row) && !row.disabled);
    if (box) {
      try {
        await browser.type(targetId, box.ref, query, true);
        await browser.settle(targetId, 1800);
        return {
          ok: true,
          detail: revealed
            ? `revealed search, typed ${JSON.stringify(query)} + enter`
            : `typed ${JSON.stringify(query)} + enter`,
          ref: box.ref,
        };
      } catch (error) {
        if (attempt >= 2) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, detail: `failed: ${message.slice(0, 120)}` };
        }
        await browser.settle(targetId, 900).catch(() => undefined);
        continue;
      }
    }
    // Some sites hide the field behind a Search control until it is pressed.
    if (!revealed && snap?.elements.length) {
      const reveal = findSearchReveal(snap.elements);
      if (reveal) {
        const outcome = await clickStable(browser, targetId, reveal);
        revealed = true;
        if (outcome.ok) {
          await browser.settle(targetId, 900);
          continue;
        }
      }
    }
    return { ok: false, detail: "no search box on this page" };
  }
  return { ok: false, detail: "search failed" };
};

/**
 * A destination is usually one link away. Read the page's own links and go
 * straight there, because a click can be swallowed by an overlay.
 */
export const findLinkTo = async (
  browser: PlaywrightSession,
  targetId: string,
  destination: string,
): Promise<string | undefined> => {
  const words = destination.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  if (!words.length) return undefined;
  const raw = await browser
    .call("browser_run_code_unsafe", {
      targetId,
      timeoutMs: 15_000,
      code: `async (page) => page.$$eval("a[href]", (rows) => rows.slice(0, 600).map((row) => ({
  href: row.href,
  text: (row.innerText || row.getAttribute("aria-label") || "").trim().slice(0, 80),
})))`,
    })
    .catch(() => undefined);
  if (!raw) return undefined;

  let links: { href: string; text: string }[];
  try {
    const parsed: unknown = JSON.parse(raw.slice(raw.indexOf("[")));
    links = Array.isArray(parsed) ? (parsed as { href: string; text: string }[]) : [];
  } catch {
    return undefined;
  }

  const scored = links
    .filter((row) => row.href.startsWith("http"))
    .map((row) => {
      const text = row.text.toLowerCase();
      const path = row.href.toLowerCase();
      const inText = words.every((word) => text.includes(word));
      const inPath = words.every((word) => path.includes(word));
      return { row, score: (inText ? 2 : 0) + (inPath ? 1 : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row.href.length - b.row.href.length);

  return scored[0]?.row.href;
};

/** Did the page reach the destination the task named? */
export const reachedDestination = (
  url: string,
  title: string,
  destination: string | undefined,
): boolean => {
  if (!destination) return false;
  const words = destination.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  if (!words.length) return false;
  const haystack = `${url} ${title}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};
