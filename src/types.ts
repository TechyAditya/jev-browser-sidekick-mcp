export type Provider = "official" | "openrouter";

/**
 * `rejected` means the page cannot satisfy the step, such as an item that is
 * out of stock. It is an answer, not a failure of the run.
 * `unverified` means every step ran but `expect` was not on the final page.
 * `partial` means the step did some of its work and stopped with more to do.
 * `error` means the Jev provider or transport failed, not the page.
 */
export type RunStatus =
  | "completed"
  | "partial"
  | "rejected"
  | "blocked"
  | "unverified"
  | "max_steps"
  | "error"
  /** Never ran, because an earlier step in the series did not complete. */
  | "skipped";

/** Why a page turned a step down. Distinct from endpoint faults. */
export type BlockReason =
  | "credentials"
  | "captcha"
  | "unavailable"
  | "sign_in"
  | "wrong_page"
  | "other_route"
  | "not_ready"
  /** A click or press step found no control that does what the step named. */
  | "no_control"
  /** A pick step found no matching entry, or Jev chose none among the candidates. */
  | "no_match"
  /**
   * The control is absent because the page already shows the step's outcome,
   * such as a product page reading "Go to cart". Jev judges this, so the
   * caller can carry on where `no_control` would tell it to stop.
   */
  | "already_done"
  | "unknown";

/** Why the Jev provider or network stopped the series. Not a page answer. */
export type EndpointReason =
  | "rate_limit"
  | "auth"
  | "no_credits"
  | "not_found"
  | "provider_outage"
  | "unreachable"
  | "proxy_interstitial"
  | "bad_response";

/** Page answer or provider fault carried on a stopped step and its handoff. */
export type StopReason = BlockReason | EndpointReason;

/**
 * Steps to repeat until the page shows `until`. Jev reads the live page after
 * every round and answers whether the condition holds, so the loop ends on the
 * page's own evidence rather than on a control disappearing.
 */
export interface LoopSpec {
  /** Steps to run, in order, once per round. */
  tasks: string[];
  /** What the finished page shows. Judged after every round. */
  until: string;
  /** Hard ceiling on rounds. Default 12, never above 50. */
  maxRounds?: number;
}

/** One step of a series: a written step, or a loop over written steps. */
export type TaskStep = string | { loop: LoopSpec };

export interface TaskGroupSpec {
  /** Parent label for this tab's series. */
  id?: string;
  /** Tab for every task in this group. If omitted, run_action opens a tab. */
  targetId?: string;
  groupId?: string;
  startUrl?: string;
  /** One task if `tasks` is omitted. Parent writes the list. */
  goal?: string;
  /** Serial tasks on this tab. */
  tasks?: TaskStep[];
  /** Keep going after a step that did not complete. Off by default. */
  noFail?: boolean;
  /** Text that proves this series worked. Checked on the final page. */
  expect?: string;
}

export interface TaskResult {
  goal: string;
  status: RunStatus;
  summary: string;
  /** Page answer or provider fault. Set when the step did not complete. */
  reason?: StopReason;
  /** Wall time this step took. Set when debug is on. */
  ms?: number;
  /** What the page said. Set by a read step. */
  text?: string;
  /** Rounds a loop step ran. Absent on every other step. */
  rounds?: number;
}

/**
 * The page a stopped series left behind. The parent owns the tab, so it can
 * type the password itself, ask the user, or call run_action again.
 */
export interface Handoff {
  /** The tab is still open. True after an endpoint fault so the caller can resume. */
  resumable: boolean;
  targetId?: string;
  groupId?: string;
  url?: string;
  title?: string;
  /** The step that stopped. */
  stoppedAt: string;
  status: RunStatus;
  reason?: StopReason;
  /** Steps that never ran. Pass them straight back to resume. */
  remaining: TaskStep[];
  /** The last few actions, for the parent to read before deciding. */
  recent: RunStep[];
}

export interface GroupResult {
  id: string;
  targetId?: string;
  groupId?: string;
  status: RunStatus;
  summary: string;
  tasks: TaskResult[];
  /** How many steps landed in each status. The rollup alone reads worst-case. */
  counts: Partial<Record<RunStatus, number>>;
  steps: RunStep[];
  url?: string;
  title?: string;
  /**
   * True when `expect` was found on the final page. False when the series
   * carried `expect` and the text was missing, or the series stopped before
   * anything could be checked. Undefined only when the series never asked.
   */
  verified?: boolean;
  /**
   * The expected text with the words around it, so the caller can tell a cart
   * line from a recommendation rail. Set when `verified` is true.
   */
  proof?: string;
  handoff?: Handoff;
  /** Wall time this series took. Set when debug is on. */
  ms?: number;
}

export interface RunActionInput {
  /** One task. Not split. Optional when `tasks` or `groups` is set. */
  goal?: string;
  /** Parent-written serial tasks on one tab. */
  tasks?: TaskStep[];
  /** Parent-written parallel groups. Each group is a series on its own tab. */
  groups?: TaskGroupSpec[];
  /** Keep going after a step that did not complete. Off by default. */
  noFail?: boolean;
  /** Text that proves the series worked. Checked on the final page. */
  expect?: string;
  /** Existing agentic-playwright-mcp tab. If omitted, run_action opens a tab. */
  targetId?: string;
  /** Existing tab group. If omitted, run_action creates a group. */
  groupId?: string;
  /** URL to open before the first decision when targetId is omitted. */
  startUrl?: string;
  /** Strings the agent may type. Keys are labels. Values are the text. */
  values?: Record<string, string>;
  /** Files the agent may read. */
  contextPaths?: string[];
  maxSteps?: number;
  /** Ceiling for the whole call. The result comes back even if work is unfinished. */
  timeoutMs?: number;
  /** Write every Playwright call and Jev decision to a JSONL trace. */
  debug?: boolean;
  /** Include the final accessibility tree as snapshot. */
  returnSnapshot?: boolean;
}

export interface RunStep {
  step: number;
  group?: string;
  task?: string;
  operation: string;
  target?: string;
  detail?: string;
  confidence?: number;
}

/**
 * Summed from what each API response reported. Nothing here is estimated, so
 * a provider that reports no price leaves `costUsd` unset and the parent
 * reads tokens instead.
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Jev calls made. */
  decisions: number;
  /** Calls to the text model that fills a field Jev cannot write. */
  textCalls: number;
  /** Only when a provider returns a price with the response. */
  costUsd?: number;
}

export interface RunActionResult {
  is_finished: true;
  status: RunStatus;
  targetIds: string[];
  groupId?: string;
  url?: string;
  title?: string;
  summary: string;
  tasks?: TaskResult[];
  groups?: GroupResult[];
  steps: RunStep[];
  /** Set when any series carried `expect`. False when one of them failed its check. */
  verified?: boolean;
  /** The first series that stopped early. Absent when everything completed. */
  handoff?: Handoff;
  snapshot?: string;
  /** Present when debug is set. JSONL of every Playwright call and Jev decision. */
  tracePath?: string;
  /** Token counts, summed from what each API response reported. Debug only. */
  usage?: UsageTotals;
  /** Wall time for the whole call. Debug only. */
  elapsedMs?: number;
  error?: string;
}

export interface JevConfig {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  openrouterApiKey?: string;
  textModel: string;
  maxSteps: number;
  loadTimeoutMs: number;
  /** Ceiling for one browser or provider call. */
  callTimeoutMs: number;
  /** Ceiling for one task in a series. */
  taskTimeoutMs: number;
  /** Ceiling for the whole run_action call. */
  runTimeoutMs: number;
  playwright: {
    command: string;
    args: string[];
    cdpEndpoint?: string;
  };
  thresholds: {
    complete: number;
    looping: number;
    blocked: number;
    minConfidence: number;
  };
}
