export interface PageElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  /** Set when the control has no role, so it is clicked by CSS selector. */
  selector?: string;
}

export interface ParsedSnapshot {
  url?: string;
  title?: string;
  elements: PageElement[];
  text: string;
}

const CLICK_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
]);

const TYPE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const SELECT_ROLES = new Set(["combobox", "listbox", "select"]);

const NOISE =
  /skip to|keyboard shortcut|delivering to|choose a language|expand to|hello, sign in|leave feedback|sponsored|frequently bought|add both|see more|next page|previous page|all categories|department you want/i;

// "Buy now" skips the cart, so it is not an add.
const ADD_RE = /add to cart|add to basket/i;
const CHECKOUT_RE = /proceed to (?:buy|checkout)|place order|go to checkout/i;
const HOT = /add to cart|add to basket|buy now|go to cart|checkout|proceed to|place order/i;

export const looksLikeAdd = (name: string): boolean => ADD_RE.test(name);
export const looksLikeCheckout = (name: string): boolean => CHECKOUT_RE.test(name);

const LINE_RE =
  /^\s*-\s+([A-Za-z0-9_-]+)(?:\s+"([^"]*)")?(?:[^\n]*?\[ref=([^\]]+)\])?(?:[^\n]*?:\s+"?([^"\n]+)"?)?/;

const URL_LINE = /(?:Page URL|url)\s*[:=]\s*(\S+)/i;
const TITLE_LINE = /(?:Page Title|title)\s*[:=]\s*(.+)$/i;

export const parseSnapshot = (raw: string): ParsedSnapshot => {
  const elements: PageElement[] = [];
  let url: string | undefined;
  let title: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const urlMatch = line.match(URL_LINE);
    if (urlMatch) url = urlMatch[1];
    const titleMatch = line.match(TITLE_LINE);
    if (titleMatch) title = titleMatch[1].trim();

    const match = line.match(LINE_RE);
    if (!match?.[3]) continue;
    const role = match[1];
    const name = (match[2] ?? "").trim();
    const ref = match[3].trim();
    const value = match[4]?.trim();
    const disabled = /\[disabled/i.test(line);
    elements.push({
      ref,
      role,
      name,
      value: value && value !== ":" ? value : undefined,
      disabled,
    });
  }

  return { url, title, elements: dedupe(elements), text: raw };
};

export const isClickable = (el: PageElement): boolean =>
  !el.disabled && (CLICK_ROLES.has(el.role) || TYPE_ROLES.has(el.role) || SELECT_ROLES.has(el.role));

export const isTypable = (el: PageElement): boolean =>
  !el.disabled && TYPE_ROLES.has(el.role);

export const isSelectable = (el: PageElement): boolean =>
  !el.disabled && SELECT_ROLES.has(el.role);

/**
 * A control whose label spells out a keyboard shortcut is the accessibility
 * shortcut bar, not the real button. It carries the same words and is invisible.
 */
const SHORTCUT_RE = /,\s*(shift|alt|ctrl|control|cmd|command|option)\b|\bshift\s*\+|\balt\s*\+/i;

export const isShortcutDecoy = (el: PageElement): boolean => SHORTCUT_RE.test(el.name);

export const isNoise = (el: PageElement): boolean =>
  // A long select of departments is chrome on every page of a site.
  el.role === "option" || isShortcutDecoy(el) || NOISE.test(`${el.name} ${el.role}`);

const CHROME_RE =
  /^(go|search|sign in|hello|account|orders|returns|cart|basket|menu|all|deliver|language|customer service|best sellers|new releases|today's deals|prime|gift|amazon|mobiles?|electronics|fashion|home|grocery|books|toys|beauty|sports|car|health)\b/i;

const JUNK_RE =
  /see all|see more|click to|visit the|shop by|compare|customer review|out of \d|items? in cart|buying options|previous|next|back to|learn more|terms|privacy|conditions|feedback|report|coupon|deal of|save extra|sponsored/i;

/**
 * Controls sit next to the entry they belong to in the accessibility tree, so
 * the button just after a chosen entry is that entry's own button.
 */
export const actionNearEntry = (
  all: PageElement[],
  entry: PageElement,
  matches: (name: string) => boolean,
  window = 25,
): PageElement | undefined => {
  const index = all.findIndex((row) => row.ref === entry.ref);
  if (index < 0) return undefined;
  for (let step = 1; step <= window; step += 1) {
    const after = all[index + step];
    if (after && !after.disabled && !isShortcutDecoy(after) && matches(after.name)) return after;
  }
  return undefined;
};

/**
 * The title this control sits under. A page can carry one "Add to cart" for
 * its own product and one per recommendation tile, all named the same, so the
 * neighbouring title is the only thing telling them apart.
 */
export const nearestTitle = (
  all: PageElement[],
  el: PageElement,
  window = 14,
): string | undefined => {
  const index = all.findIndex((row) => row.ref === el.ref);
  if (index < 0) return undefined;
  for (let step = 1; step <= window; step += 1) {
    const before = all[index - step];
    if (!before) break;
    const name = before.name.trim();
    if (
      name.length >= 20 &&
      !isNoise(before) &&
      !looksLikeAdd(name) &&
      !looksLikeCheckout(name)
    ) {
      return clip(name, 60);
    }
  }
  return undefined;
};

/** A page showing many similar titled links is a list of results. */
export const looksLikeList = (elements: PageElement[], hints: string[]): boolean =>
  resultCandidates(elements, hints).length >= 3;

/** An entry in a list links to its own page; the surrounding chrome does not. */
export const resultCandidates = (elements: PageElement[], hints: string[]): PageElement[] => {
  const links = elements.filter(
    (el) =>
      el.role === "link" &&
      !el.disabled &&
      el.name.trim().length >= 20 &&
      !CHROME_RE.test(el.name.trim()) &&
      !JUNK_RE.test(el.name) &&
      !looksLikeAdd(el.name) &&
      !looksLikeCheckout(el.name),
  );
  const subject = hints.filter(Boolean).join(" ").trim();
  // Require the entry to name the wanted thing. Falling back to every long
  // link turns "open the result" into "click anything" when no entry matches.
  if (!subject) return links;
  return links.filter((el) => mentions(el.name, subject));
};

/**
 * A field this server never fills. The parent owns the same tab, so it can
 * type the secret itself or ask the person.
 */
const SECRET_RE =
  /password|passcode|passwd|\bpin\b|one[-\s]?time|\botp\b|verification code|security code|2fa|two[-\s]factor|authenticator/i;

const CAPTCHA_RE =
  /captcha|recaptcha|hcaptcha|verify (?:you are|that you are) (?:a )?human|not a robot|robot check|security check|puzzle/i;

export type SecretKind = "credentials" | "captcha";

export const isSecretField = (el: PageElement): boolean =>
  isTypable(el) && SECRET_RE.test(`${el.name} ${el.value ?? ""}`);

/**
 * What the page might be demanding before it will go further.
 *
 * This is a suspicion, not a verdict. The words alone prove nothing: a news
 * story titled "Solving a corn puzzle with CP-SAT" carries the same word a
 * challenge does, and stopping a whole series on that is worse than the miss
 * it guards against. Jev reads the page and confirms before the step hands
 * back, so this side stays broad and cheap.
 */
export const secretDemand = (
  elements: PageElement[],
): { kind: SecretKind; evidence: string[] } | undefined => {
  const challenge = elements.filter((el) => CAPTCHA_RE.test(el.name));
  if (challenge.length) {
    return { kind: "captcha", evidence: challenge.slice(0, 4).map(describeElement) };
  }
  const secret = elements.filter(isSecretField);
  if (secret.length) {
    return { kind: "credentials", evidence: secret.slice(0, 4).map(describeElement) };
  }
  return undefined;
};

const flatten = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * Where the proof text sits on the page, with its neighbours. A shop repeats
 * product names in recommendation rails, so the words alone prove little and
 * the caller needs to see what surrounds them.
 */
export const proofContext = (
  pageText: string,
  expected: string,
  span = 70,
): string | undefined => {
  const flat = flatten(pageText);
  const wanted = flatten(expected);
  if (!wanted) return undefined;
  const at = flat.toLowerCase().indexOf(wanted.toLowerCase());
  if (at < 0) return undefined;
  const from = Math.max(0, at - span);
  const to = Math.min(flat.length, at + wanted.length + span);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
};

/**
 * Does this text name the same thing? A product title arrives abbreviated in
 * a snapshot and spelled out on its own page, so ask for most of its
 * distinctive words rather than the whole string.
 */
export const mentions = (text: string, name: string): boolean => {
  const words = flatten(name)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4);
  if (!words.length) return false;
  const haystack = flatten(text).toLowerCase();
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits >= Math.max(2, Math.ceil(words.length / 2));
};

/** Is the proof text on the page? Case and spacing do not have to match. */
export const pageShows = (pageText: string, expected: string): boolean =>
  proofContext(pageText, expected) !== undefined;

export const shortRole = (role: string): string => {
  if (role === "textbox" || role === "searchbox") return "type";
  if (role === "button") return "btn";
  if (role === "link") return "link";
  if (role === "combobox") return "combo";
  return role.slice(0, 8);
};

export const describeElement = (el: PageElement): string => {
  const name = clip(el.name, 48);
  const value = el.value ? ` holding "${clip(el.value, 24)}"` : "";
  if (looksLikeAdd(el.name)) return `ADD button "${name}". Adds the item on this page to the cart.`;
  if (looksLikeCheckout(el.name)) return `PAY button "${name}". Opens checkout.`;
  return `${shortRole(el.role)} "${name}"${value}`;
};

/**
 * A CSS path for a role-less control runs to hundreds of characters, and the
 * same one is echoed in several places in a result. Keep the ends, which is
 * what a reader uses, and drop the middle.
 */
export const shortRef = (ref: string): string =>
  ref.length <= 80 ? ref : `${ref.slice(0, 40)}…${ref.slice(-32)}`;

export const elementTable = (elements: PageElement[], limit = 36): string =>
  elements
    .slice(0, limit)
    .map((el) => `${el.ref} ${describeElement(el)}`)
    .join("\n");

export const shortUrl = (url?: string): string => {
  if (!url) return "";
  try {
    const parsed = new URL(url, "https://local.invalid");
    const query = parsed.searchParams.get("k") ?? parsed.searchParams.get("q") ?? "";
    const path = parsed.pathname.length > 48 ? `${parsed.pathname.slice(0, 47)}…` : parsed.pathname;
    return `${parsed.hostname}${path}${query ? `?k=${clip(query, 32)}` : ""}`;
  } catch {
    return clip(url, 64);
  }
};

export const prioritize = (
  elements: PageElement[],
  limit = 36,
  hints: string[] = [],
  opts?: { hideSearch?: boolean },
): PageElement[] => {
  const hint = hints.join(" ").toLowerCase();
  const rank = (el: PageElement): number => {
    if (isNoise(el)) return 50;
    if (opts?.hideSearch && isTypable(el)) return 20;
    const blob = `${el.name} ${el.value ?? ""}`.toLowerCase();
    if (looksLikeAdd(el.name) || looksLikeCheckout(el.name)) return 0;
    if (HOT.test(blob)) return 0;
    if (hint && hint.split(/\s+/).some((word) => word.length > 2 && blob.includes(word))) return 1;
    if (isTypable(el)) return 2;
    if (el.role === "button" || el.role === "link") return 3;
    if (CLICK_ROLES.has(el.role)) return 4;
    return 8;
  };
  return [...elements]
    .filter((el) => !isNoise(el))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
};

export const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const dedupe = (elements: PageElement[]): PageElement[] => {
  const seen = new Set<string>();
  const out: PageElement[] = [];
  for (const el of elements) {
    if (seen.has(el.ref)) continue;
    seen.add(el.ref);
    out.push(el);
  }
  return out;
};
