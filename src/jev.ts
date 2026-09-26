import { TypeSafeClient, type EntryType, type Questions } from "@typesafe-ai/sdk";
import { OpenRouter } from "@openrouter/sdk";
import type { JevConfig } from "./types.js";
import { noTrace, type Trace } from "./trace.js";

export type { Questions };
export type Question = Questions[string];

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** What the response itself reported. Token counts are never estimated. */
export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Only when the provider returns a price. TypeSafe returns tokens only. */
  costUsd?: number;
}

export interface DecisionResult {
  answers: Record<string, Answer>;
  usage: DecisionUsage;
  model?: string;
}

export interface JevClient {
  decide(state: EntryType, questions: Questions, model?: string): Promise<DecisionResult>;
}

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizeAnswer = (raw: unknown): Answer => {
  const row = (raw ?? {}) as Record<string, unknown>;
  const type = row.type;
  if (type === "noul") {
    return { type: "noul", noul: asNumber(row.noul) };
  }
  if (type === "score") {
    return {
      type: "score",
      score: asNumber(row.score),
      confidence: asNumber(row.confidence),
      legend: row.legend as Record<string, string> | undefined,
      probabilities: row.probabilities as Record<string, number> | undefined,
    };
  }
  return {
    type: "choice",
    choice: String(row.choice ?? ""),
    probabilities: (row.probabilities ?? {}) as Record<string, number>,
    confidence: asNumber(row.confidence),
  };
};

/**
 * Every System One response carries usage.input_tokens and usage.output_tokens.
 * https://docs.typesafe.ai/api
 */
const usageFrom = (raw: unknown): DecisionUsage => {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    inputTokens: asNumber(row.input_tokens ?? row.inputTokens),
    outputTokens: asNumber(row.output_tokens ?? row.outputTokens),
    costUsd:
      typeof row.cost === "number"
        ? row.cost
        : typeof row.costUsd === "number"
          ? row.costUsd
          : undefined,
  };
};

const stderrLogger = {
  debug: (message: string, ...args: unknown[]) => {
    process.stderr.write(`[typesafe] ${message} ${args.length ? JSON.stringify(args) : ""}\n`);
  },
  info: (message: string, ...args: unknown[]) => {
    process.stderr.write(`[typesafe] ${message} ${args.length ? JSON.stringify(args) : ""}\n`);
  },
  warn: (message: string, ...args: unknown[]) => {
    process.stderr.write(`[typesafe] ${message} ${args.length ? JSON.stringify(args) : ""}\n`);
  },
  error: (message: string, ...args: unknown[]) => {
    process.stderr.write(`[typesafe] ${message} ${args.length ? JSON.stringify(args) : ""}\n`);
  },
};

const typesafeClient = (config: JevConfig): TypeSafeClient =>
  new TypeSafeClient({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    defaultModel: config.model,
    timeout: 20_000,
    logLevel: "error",
    logger: stderrLogger,
  });

const decideWithTypeSafe = async (
  client: TypeSafeClient,
  state: EntryType,
  questions: Questions,
  model: string,
  trace: Trace,
): Promise<DecisionResult> => {
  const payload = { model, state, questions };
  const started = Date.now();
  const response = await client.systemOne(payload);
  trace.record({
    kind: "request",
    name: "typesafe.systemOne",
    ms: Date.now() - started,
    ok: true,
    endpoint: "/v1/systemone",
    payload,
    response,
  });
  const raw = response as unknown as {
    answers?: Record<string, unknown>;
    usage?: unknown;
    model?: string;
  };
  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(raw.answers ?? {})) {
    answers[id] = normalizeAnswer(value);
  }
  return { answers, usage: usageFrom(raw.usage), model: raw.model };
};

const decideWithOpenRouterSdk = async (
  apiKey: string,
  state: EntryType,
  questions: Questions,
  model: string,
  trace: Trace,
): Promise<DecisionResult> => {
  const client = new OpenRouter({
    apiKey,
    httpReferer: "https://github.com/TechyAditya/jev-browser-sidekick-mcp",
    appTitle: "jev-browser-sidekick-mcp",
  });
  const routed = model.includes("/") ? model : `typesafe/${model}`;
  const decisionsRequest = {
    model: routed,
    state: state as { [k: string]: any },
    questions: questions as never,
  };
  const started = Date.now();
  const response = await client.alpha.decisions.create({ decisionsRequest });
  trace.record({
    kind: "request",
    name: "openrouter.decisions.create",
    ms: Date.now() - started,
    ok: true,
    endpoint: "/api/alpha/decisions",
    payload: decisionsRequest,
    response,
  });
  const raw = response as unknown as {
    answers?: Record<string, unknown>;
    usage?: unknown;
    model?: string;
  };
  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(raw.answers ?? {})) {
    answers[id] = normalizeAnswer(value);
  }
  return { answers, usage: usageFrom(raw.usage), model: raw.model };
};

/** TypeSafeClient.systemOne. On openrouter failure, OpenRouter.alpha.decisions.create. */
export const createJevClient = (config: JevConfig, trace: Trace = noTrace): JevClient => {
  const sdk = typesafeClient(config);
  return {
    async decide(state, questions, model = config.model) {
      try {
        return await decideWithTypeSafe(sdk, state, questions, model, trace);
      } catch (error) {
        trace.record({
          kind: "request",
          name: "typesafe.systemOne",
          ok: false,
          payload: { model, state, questions },
          error: error instanceof Error ? error.message : String(error),
        });
        if (config.provider === "openrouter" && config.apiKey) {
          return decideWithOpenRouterSdk(config.apiKey, state, questions, model, trace);
        }
        throw error;
      }
    },
  };
};

export const choiceOf = (answers: Record<string, Answer>, id: string): ChoiceAnswer | undefined => {
  const answer = answers[id];
  return answer?.type === "choice" ? answer : undefined;
};

export const noulOf = (answers: Record<string, Answer>, id: string, fallback = 0): number => {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : fallback;
};

export const scoreOf = (answers: Record<string, Answer>, id: string, fallback = 0): number => {
  const answer = answers[id];
  return answer?.type === "score" ? answer.score : fallback;
};
