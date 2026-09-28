import type { Questions } from "./jev.js";
import {
  describeElement,
  isClickable,
  isSelectable,
  isTypable,
  nearestTitle,
  type PageElement,
} from "./snapshot.js";

export const OPERATIONS = [
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "SCROLL_DOWN",
  "WAIT",
  "NAVIGATE",
  "READ_FILE",
  "PRESS_ENTER",
] as const;

export type Operation = (typeof OPERATIONS)[number];

export interface ActionSpace {
  click: PageElement[];
  type: PageElement[];
  select: PageElement[];
  urls: string[];
  values: { id: string; label: string; text: string }[];
  files: string[];
  findTerms: string[];
}

/**
 * Jev reads instructions literally, so each one names the task and the exact
 * condition. https://docs.typesafe.ai/model-jaggedness/jev-1.13
 */
const clickInstruction = (task: string, pick = false): string => {
  if (pick) {
    return `Task: ${task}. Choose the one result entry to open from the listed links. A result entry is a row in a list of search hits or matches. Choose ${NO_CONTROL} when this page is not that kind of list: when \`page_title\` already is the wanted entry, when \`steps_done\` shows an earlier step already opened it, or when every listed link would open something else (a citation, further reading, or a different topic). Do not choose a self-link that merely repeats the page's own title.`;
  }
  return `Task: ${task}. Choose the one element to click next to finish that task. Use \`motive\` and \`steps_done\` when they are present: if an earlier step already reached what this task asks for, or if none of the listed elements carries out the task, choose ${NO_CONTROL}. Rows marked ADD add the item to the cart. Rows marked PAY open checkout. Do not choose an advertisement or a different product.`;
};

const typeInstruction = (task: string): string =>
  `Task: ${task}. Choose the one text field to type the search words into.`;

const valueInstruction = (task: string): string =>
  `Task: ${task}. Choose the one item named in that task.`;

const navigateInstruction = (task: string): string =>
  `Task: ${task}. Choose the one address to open next.`;

const fileInstruction = (task: string): string =>
  `Task: ${task}. Choose the one file to read for the words this task needs.`;

const operationInstruction = (task: string): string =>
  `Task: ${task}. Choose the one action to take next on this page.`;

/** Chosen when no control in the list does the task. */
export const NO_CONTROL = "none";

const criteriaFor = (
  elements: PageElement[],
  all: PageElement[] = elements,
): Record<string, string> => {
  const criteria: Record<string, string> = {};
  for (const el of elements) {
    criteria[el.ref] = describeCandidate({ ...el, near: nearestTitle(all, el) });
  }
  return criteria;
};

export const buildActionSpace = (
  elements: PageElement[],
  extras: {
    urls: string[];
    values: { id: string; label: string; text: string }[];
    files: string[];
    findTerms: string[];
  },
): ActionSpace => ({
  click: elements.filter(isClickable).slice(0, 36),
  type: elements.filter(isTypable).slice(0, 6),
  select: elements.filter(isSelectable).slice(0, 4),
  urls: extras.urls.slice(0, 4),
  values: extras.values.slice(0, 8),
  files: extras.files.slice(0, 4),
  findTerms: [],
});

export const availableOperations = (
  space: ActionSpace,
  pageEmpty: boolean,
  lastOp?: string,
  flags?: {
    allowType?: boolean;
    allowNavigate?: boolean;
    clickOnly?: boolean;
    /**
     * The step named a control the harness could not find. Clicking is off,
     * because every remaining option is something the step did not ask for.
     */
    noClick?: boolean;
  },
): Operation[] => {
  const ops: Operation[] = [];
  if (space.click.length && !flags?.noClick) ops.push("CLICK");
  // With a product or an Add button on screen, scrolling is never the answer.
  if (flags?.clickOnly && ops.length) return ops;
  if ((flags?.allowType ?? true) && space.type.length) ops.push("TYPE_TEXT");
  if (space.select.length) ops.push("SELECT");
  if (space.urls.length && (pageEmpty || flags?.allowNavigate)) ops.push("NAVIGATE");
  if (space.files.length) ops.push("READ_FILE");
  if (lastOp === "TYPE_TEXT") ops.push("PRESS_ENTER");
  ops.push("SCROLL_DOWN", "WAIT");
  return ops;
};

const OP_NOTE: Partial<Record<Operation, string>> = {
  CLICK: "Click one element on this page.",
  TYPE_TEXT: "Type the search words into a text field.",
  SELECT: "Pick a value in a dropdown.",
  SCROLL_DOWN: "Scroll down because the element needed is below the fold.",
  WAIT: "Wait because the page is still working, such as a spinner or a blank area.",
  NAVIGATE: "Open a different address.",
  READ_FILE: "Read a file for the words this task needs.",
  PRESS_ENTER: "Press Enter to submit the text just typed.",
};

/** The option label for the nth candidate. Code maps it back to the element. */
export const controlOption = (index: number): string => `c${index + 1}`;

/**
 * The harness finds every control carrying the task's words. Which one is the
 * right one is a judgment, so Jev picks, and `none` lets it reject all of them.
 *
 * Options are numbered rather than named by ref, because a control with no
 * role is addressed by a CSS path hundreds of characters long, and an option
 * label like that is noise Jev cannot vouch for.
 */
/** What a control does, plus the title it sits under when there is one. */
export const describeCandidate = (el: PageElement & { near?: string }): string =>
  el.near ? `${describeElement(el)} It sits under "${el.near}".` : describeElement(el);

export const buildControlQuestions = (
  task: string,
  candidates: Array<PageElement & { near?: string }>,
): Questions => ({
  control: {
    type: "choice",
    instructions: `Task: ${task}. The harness read this page and found the controls listed in \`controls\`. Choose the one that carries out the task for the page's own subject, named in \`page_title\`. Use \`motive\` and \`steps_done\` when they are present: if an earlier step already reached what this task asks for, choose ${NO_CONTROL}. Several controls can share a label because a page advertises other products alongside its own, so use the title each one sits under. Choose ${NO_CONTROL} only when every control would do something else.`,
    criteria: {
      ...Object.fromEntries(
        candidates.map((el, index) => [controlOption(index), describeCandidate(el)]),
      ),
      [NO_CONTROL]: "None of these controls does the task.",
    },
  },
});

/**
 * The page may simply not offer the step. Asking why is a judgment, so Jev
 * answers it from labelled reasons and code decides what to do.
 */
export const buildBlockerQuestions = (task: string): Questions => ({
  blocked: {
    type: "noul",
    instructions: `Task: ${task}. The page in the state offers no way to do that task.`,
  },
  // Asked in the same call: the questions share one state, answer in parallel,
  // and this one costs a few output tokens. https://docs.typesafe.ai/patterns/fan-out
  ...buildOutcomeQuestions(task),
  blocker: {
    type: "choice",
    instructions: `Task: ${task}. Choose the one reason the page offers no way to do it.`,
    criteria: {
      unavailable:
        "The item is out of stock, sold out, currently unavailable, or not delivered to this address.",
      sign_in: "The page asks the user to sign in or verify before going further.",
      credentials: "The page asks for a password, a one-time code, or another secret.",
      captcha: "The page asks the user to prove they are a human.",
      wrong_page: "This page is not about the wanted thing at all.",
      not_ready: "The page is still loading, or the part needed has not appeared yet.",
      other_route: "The page offers a different route, such as other sellers or buying options.",
    },
  },
});

/**
 * The harness spotted words a sign-in wall or a challenge uses. Whether the
 * page is really demanding one is a judgment, and a wrong yes stops a whole
 * series, so Jev confirms it against the page before the step hands back.
 */
export const buildDemandQuestions = (
  kind: "credentials" | "captcha",
  task: string,
  evidence: string[],
): Questions => {
  const what =
    kind === "captcha"
      ? "prove the user is human, with a challenge the user has to clear"
      : "type a password, a one-time code, or another secret";
  return {
    demand: {
      type: "noul",
      instructions: `Task: ${task}. The harness found these on the page: ${evidence.join("; ")}. Judge one thing: is the page itself demanding that someone ${what} before it will go further? Read \`page_title\`, \`page_text\`, and \`page_elements\`. Words that merely appear in a headline, a story title, a link, or ordinary body text are not a demand.`,
      criteria: {
        true: `The page is demanding it now, and the task cannot go on until someone does it.`,
        false: `The page is not demanding it. The words belong to page content, an unrelated control, or a part of the page the task does not touch.`,
      },
    },
  };
};

/**
 * A loop ends on the page's own evidence, never on a control disappearing:
 * a site that redraws its list mid-round would otherwise read as finished.
 */
export const buildLoopQuestions = (until: string, roundsDone: number): Questions => ({
  loop_done: {
    type: "noul",
    instructions: `A step is being repeated until this holds: ${until}. Read the live page in \`page_title\`, \`page_text\`, and \`page_elements\`, and answer whether it holds now. ${roundsDone} rounds have run, which is evidence of nothing on its own. Answer true only for what the page shows, not for what one more round could reach.`,
    criteria: {
      true: "The page shows the condition holds, so another round would do nothing.",
      false: "The page does not show it yet, so another round is due.",
    },
  },
});

/**
 * An absent control means one of two things, and the caller acts differently
 * on each: the page cannot do the step at all, or the page already shows the
 * step's outcome. Only the page says which, so Jev reads it.
 */
export const buildOutcomeQuestions = (task: string): Questions => ({
  already_done: {
    type: "noul",
    instructions: `Task: ${task}. No control on this page carries out that task. Judge one thing: does the page already show that task's outcome? Read \`page_title\`, \`page_text\`, and \`page_elements\`, and use \`steps_done\` when it is there. Judge the page as it stands, not what a later step could reach.`,
    criteria: {
      true: "The outcome is already in place: the control the task would press has been replaced by the one that follows it, such as Go to cart where Add to cart was, or the page already is the thing the task asked to open.",
      false: "The outcome is not in place. This page simply cannot do the task.",
    },
  },
});

export const buildQuestions = (
  space: ActionSpace,
  ops: Operation[],
  task: string,
  pageElements?: PageElement[],
  flags?: { pick?: boolean },
): Questions => {
  // Page kind and readiness come from the URL and from waits in code, not from Jev.
  // https://docs.typesafe.ai/model-jaggedness/jev-1.13
  const page = pageElements ?? space.click;
  const questions: Questions = {
    operation: {
      type: "choice",
      instructions: operationInstruction(task),
      criteria: Object.fromEntries(ops.map((op) => [op, OP_NOTE[op] ?? op])),
    },
  };

  // Cheap to ask on every step, and it is the one thing code cannot see: a
  // page that is not what the task was written for.
  // https://docs.typesafe.ai/patterns/fan-out
  questions.unexpected = {
    type: "noul",
    instructions: `Task: ${task}. The page in the state is standing in the way of the user: it is a sign-in wall, an error page, or a check the user has to clear before the page will do anything. Judge only that. A page that is merely missing the control the task names, or has not finished drawing, is not standing in the way.`,
    criteria: {
      true: "A sign-in wall, an error page, a captcha, or another interruption the user has to clear.",
      false:
        "An ordinary page. This includes a page where the control the task names is absent from the list, because the list does not carry every control the page draws.",
    },
  };

  if (ops.includes("WAIT")) {
    questions.wait_seconds = {
      type: "choice",
      instructions: `Task: ${task}. Choose how long this page needs before it will be ready.`,
      criteria: {
        "2": "Almost ready. A moment is enough.",
        "5": "Still working, such as a spinner or a half-drawn page.",
        "10": "A slow page, such as a payment step, a search over many records, or an upload.",
      },
    };
  }
  if (space.click.length && ops.includes("CLICK")) {
    questions.click_target = {
      type: "choice",
      instructions: clickInstruction(task, flags?.pick),
      criteria: {
        ...criteriaFor(space.click, page),
        [NO_CONTROL]: flags?.pick
          ? "This page is not a list of results for the wanted entry, or none of the links is that entry."
          : "None of these elements does the task.",
      },
    };
  }
  if (space.type.length && ops.includes("TYPE_TEXT")) {
    questions.type_target = {
      type: "choice",
      instructions: typeInstruction(task),
      criteria: criteriaFor(space.type, page),
    };
  }
  if (space.select.length && ops.includes("SELECT")) {
    questions.select_target = {
      type: "choice",
      instructions: typeInstruction(task),
      criteria: criteriaFor(space.select, page),
    };
  }
  if (space.urls.length && ops.includes("NAVIGATE")) {
    questions.navigate_target = {
      type: "choice",
      instructions: navigateInstruction(task),
      criteria: Object.fromEntries(space.urls.map((url) => [url, url])),
    };
  }
  if (space.values.length && ops.includes("TYPE_TEXT")) {
    questions.type_value = {
      type: "choice",
      instructions: valueInstruction(task),
      criteria: Object.fromEntries(space.values.map((row) => [row.id, row.text])),
    };
  }
  if (space.files.length && ops.includes("READ_FILE")) {
    questions.file_target = {
      type: "choice",
      instructions: fileInstruction(task),
      criteria: Object.fromEntries(space.files.map((path) => [path, path])),
    };
  }

  return questions;
};
