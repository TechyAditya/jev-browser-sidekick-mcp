export type Provider = "official" | "openrouter";

/**
 * `rejected` means the page cannot satisfy the step, such as an item that is
 * out of stock. It is an answer, not a failure of the run.
 * `unverified` means every step ran but `expect` was not on the final page.
 * `partial` means the step did some of its work and stopped with more to do.
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

/** Why a step stopped and handed the page back. */
export type BlockReason =
  | "credentials"
  | "captcha"
  | "unavailable"
  | "sign_in"
  | "wrong_page"
  | "other_route"
  | "not_ready"
  /** The page carries no control doing what the step named. */
  | "no_control"
  /** The list on the page holds no entry matching what the step named. */
  | "no_match"
  | "unknown";

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
  tasks?: string[];
  /** Keep going after a step that did not complete. Off by default. */
  noFail?: boolean;
  /** Text that proves this series worked. Checked on the final page. */
  expect?: string;
}

export interface TaskResult {
  goal: string;
  status: RunStatus;
  summary: string;
  /** Why the page could not satisfy the step. Set when status is rejected or blocked. */
  reason?: BlockReason;
  /** Wall time this step took. Set when debug is on. */
  ms?: number;
  /** What the page said. Set by a read step. */
  text?: string;
}

/**
 * The page a stopped series left behind. The parent owns the tab, so it can
 * type the password itself, ask the user, or call run_action again.
 */
export interface Handoff {
  /** The tab is still open and usable. */
  resumable: boolean;
  targetId?: string;
  groupId?: string;
  url?: string;
  title?: string;
  /** The step that stopped. */
  stoppedAt: string;
  status: RunStatus;
  reason?: BlockReason;
  /** Steps that never ran. */
  remaining: string[];
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
  tasks?: string[];
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
