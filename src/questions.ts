import type { Questions } from "./jev.js";
import { describeElement, isClickable, isSelectable, isTypable, type PageElement } from "./snapshot.js";

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
const clickInstruction = (task: string): string =>
  `Task: ${task}. Choose the one element to click next to finish that task. Rows marked ADD add the item to the cart. Rows marked PAY open checkout. Do not choose an advertisement or a different product.`;

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

const criteriaFor = (elements: PageElement[]): Record<string, string> => {
  const criteria: Record<string, string> = {};
  for (const el of elements) {
    criteria[el.ref] = describeElement(el);
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

/** Chosen when no control in the list does the task. */
export const NO_CONTROL = "none";

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
    instructions: `Task: ${task}. The harness read this page and found the controls listed in \`controls\`. Choose the one that carries out the task for the page's own subject, named in \`page_title\`. Several controls can share a label because a page advertises other products alongside its own, so use the title each one sits under. Choose ${NO_CONTROL} only when every control would do something else.`,
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

export const buildQuestions = (space: ActionSpace, ops: Operation[], task: string): Questions => {
  // Page kind and readiness come from the URL and from waits in code, not from Jev.
  // https://docs.typesafe.ai/model-jaggedness/jev-1.13
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
      instructions: clickInstruction(task),
      criteria: criteriaFor(space.click),
    };
  }
  if (space.type.length && ops.includes("TYPE_TEXT")) {
    questions.type_target = {
      type: "choice",
      instructions: typeInstruction(task),
      criteria: criteriaFor(space.type),
    };
  }
  if (space.select.length && ops.includes("SELECT")) {
    questions.select_target = {
      type: "choice",
      instructions: typeInstruction(task),
      criteria: criteriaFor(space.select),
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
