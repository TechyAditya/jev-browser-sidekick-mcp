const STOP = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "my",
  "our",
  "to",
  "into",
  "onto",
  "on",
  "in",
  "at",
  "for",
  "of",
  "from",
  "with",
  "and",
  "then",
  "please",
  "page",
  "button",
  "first",
  "best",
  "top",
  "result",
  "results",
  "matching",
]);

/** Ask the page for something. */
const SEARCH_VERBS = /^(?:search|find|look\s+up|look\s+for|query)\b/i;

/** Press a named control. */
const PRESS_VERBS = /^(?:click|press|tap|hit|submit|toggle|check|choose\s+the\s+button)\b/i;

/** Go somewhere. */
const GOTO_VERBS = /^(?:open|go\s+to|visit|navigate\s+to|view|browse)\b/i;

/** Pick one entry out of many. */
const PICK_VERBS = /^(?:pick|choose|select)\b/i;

/** Act on a thing, naming the control indirectly: "add X to cart". */
const ACT_ON_VERBS =
  /^(?:add|buy|order|book|subscribe|register|reserve|download|upload|install|apply|save|send|post|share|follow)\b/i;

/**
 * Press the same control until the page stops offering it.
 *
 * "clear the cart" is one use of this, not the shape itself: the shape is
 * repetition, and any page that lists removable things needs it. A step can
 * say the repetition outright and name its own control.
 */
const REPEAT_VERBS =
  /^(?:keep\s+(?:clicking|pressing)|press\s+every|click\s+every|remove\s+(?:all|every)|delete\s+(?:all|every)|dismiss\s+all|clear|empty)\b/i;

/** The control a bare "clear <thing>" is asking for. */
const CLEAR_LABELS = ["delete", "remove"];

/** Hand the page's own words back to the caller. No judgment, no click. */
const READ_VERBS = /^(?:read|show|list|report|extract)\b/i;

/**
 * Words that say "one of many", so the step is choosing an entry rather than
 * reaching a place. They are all stop words, so read them before stripping.
 */
const LIST_WORDS = /\b(?:results?|matching|best match|listings?|entry|entries|first|top)\b/i;

export type IntentKind = "search" | "press" | "goto" | "pick" | "repeat" | "read" | "free";

export interface TaskIntent {
  kind: IntentKind;
  /** Labels a button on the page is likely to carry. */
  actionLabels: string[];
  /** Words the wanted thing carries, for ranking entries. */
  subject: string;
  /** Text to put in a search box. */
  query?: string;
  /** A page the task wants to land on. */
  destination?: string;
}

const clean = (value: string): string => value.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();

const meaningful = (value: string): string =>
  clean(value)
    .split(" ")
    .filter((word) => !STOP.has(word.toLowerCase()))
    .join(" ");

const afterVerb = (text: string, verb: RegExp): string => clean(text.replace(verb, ""));

/**
 * One parent-written step becomes one kind of work. The words in the task are
 * the whole contract; no site knowledge is used.
 */
/**
 * A trailing "if not already added" is dropped, not acted on. Whether the
 * outcome already holds is a judgment that finished a step without doing it,
 * so the step runs and answers rejected when the control is not there. The
 * clause still comes off, because left in it becomes part of the label and
 * then matches no control at all.
 */
const ALREADY_CLAUSE = /[,;]?\s*\b(?:if|unless|when)\b[^,;]*\balready\b[^,;]*$/i;

export const parseIntent = (task: string): TaskIntent =>
  parseAction(clean(clean(task).replace(ALREADY_CLAUSE, "")));

const parseAction = (text: string): TaskIntent => {

  if (READ_VERBS.test(text)) {
    return { kind: "read", actionLabels: [], subject: meaningful(afterVerb(text, READ_VERBS)) };
  }

  if (REPEAT_VERBS.test(text)) {
    const tail = afterVerb(text, REPEAT_VERBS);
    // "keep clicking Load more" names its control. "clear the cart" does not,
    // so fall back to the words a remove control usually carries.
    const named = clean(tail.replace(/\buntil\b[\s\S]*$/i, "").replace(/\bbutton\b/i, ""));
    const looksLikeContainer = /\b(cart|basket|list|bag|selection|filters?)\b/i.test(named);
    const actionLabels = named && !looksLikeContainer ? [named] : CLEAR_LABELS;
    return { kind: "repeat", actionLabels, subject: meaningful(tail) };
  }

  if (SEARCH_VERBS.test(text)) {
    const query = meaningful(afterVerb(text, SEARCH_VERBS));
    return { kind: "search", actionLabels: [], subject: query, query: query || undefined };
  }

  if (PRESS_VERBS.test(text)) {
    const tail = clean(afterVerb(text, PRESS_VERBS).replace(/\bbutton\b/i, ""));
    // "Delete for the Coca-Cola item" names a control and the row it sits on.
    // Only the leading words are on the control, so a whole-phrase label
    // matches nothing and the press never counts as done.
    const split = tail.match(/^(.*?)\s+(?:for|on|in|of|next to|beside)\s+(?:the\s+)?(.+)$/i);
    const label = clean(split?.[1] ?? tail);
    const subject = meaningful(split?.[2] ?? "");
    return { kind: "press", actionLabels: label ? [label] : [], subject: subject || label };
  }

  if (PICK_VERBS.test(text)) {
    const subject = meaningful(afterVerb(text, PICK_VERBS));
    return { kind: "pick", actionLabels: [], subject };
  }

  if (GOTO_VERBS.test(text)) {
    const tail = afterVerb(text, GOTO_VERBS);
    // Read the tail before the stop words go, because the words that say
    // "one of many" are stop words: best, matching, first, result.
    const fromList = LIST_WORDS.test(tail);
    // "open the cart page" names a destination; "open the aloo bhujia product"
    // names one entry among many. A short tail is a destination.
    const words = meaningful(tail);
    const short = words.split(" ").filter(Boolean).length <= 2;
    return short && !fromList
      ? { kind: "goto", actionLabels: [], subject: words, destination: words }
      : { kind: "pick", actionLabels: [], subject: words };
  }

  if (ACT_ON_VERBS.test(text)) {
    const verb = text.match(ACT_ON_VERBS)?.[0]?.toLowerCase() ?? "";
    const tail = afterVerb(text, ACT_ON_VERBS);
    const where = tail.match(/\b(?:to|into|in|on)\s+(?:the\s+)?([a-z][a-z\s]{1,24})$/i)?.[1];
    const subject = meaningful(where ? tail.slice(0, tail.length - where.length) : tail);
    const labels = where ? [clean(`${verb} to ${where}`), verb] : [verb];
    return { kind: "press", actionLabels: labels, subject, query: subject || undefined };
  }

  const subject = meaningful(text);
  return { kind: "free", actionLabels: [], subject };
};

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does the label lead the name and end on a word boundary? "Add to cart" leads
 * with "add". "Additional information" only starts with the same three letters.
 */
export const startsWithLabel = (name: string, label: string): boolean => {
  const text = clean(name).toLowerCase();
  const phrase = clean(label).toLowerCase();
  if (!phrase || !text.startsWith(phrase)) return false;
  return !/[a-z0-9]/i.test(text.charAt(phrase.length));
};

/**
 * Does this control carry the label the task named? The words must appear
 * together and lead the name. A product title saying "helps remove stains" is
 * not a Remove button, and matching it loosely clicks the wrong thing.
 */
export const matchesActionLabel = (name: string, labels: string[]): boolean => {
  const text = clean(name).toLowerCase();
  if (!text) return false;
  return labels.some((label) => {
    const phrase = clean(label).toLowerCase();
    if (!phrase) return false;
    if (startsWithLabel(text, phrase)) return true;
    // Allow the phrase mid-name only on a short label, never inside prose.
    if (text.length > 60) return false;
    return new RegExp(`\\b${escape(phrase)}\\b`).test(text);
  });
};
