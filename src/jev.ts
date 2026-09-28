import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  type EntryType,
  type Questions,
} from "@typesafe-ai/sdk";
import { OpenRouter } from "@openrouter/sdk";
import { classifyProviderError, EndpointError, isEndpointError } from "./endpoint.js";
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
    // Fail loud on the first provider answer. The series stops and stays
    // resumable; silent multi-minute retries hid proxy and auth faults.
    retry: { maxRetries: 0 },
    logLevel: "error",
    logger: stderrLogger,
  });

/**
 * Proxies and firewalls sometimes return an HTML page with a 200. Treating
 * that as a decision yields empty answers and a silent zero-token "success".
 */
export const parseDecisionBody = (
  response: unknown,
  questionCount: number,
): { answers: Record<string, Answer>; usage: DecisionUsage; model?: string } => {
  let body: unknown = response;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed || trimmed.startsWith("<")) {
      throw new EndpointError("proxy_interstitial", {
        httpStatus: 200,
        providerMessage: trimmed.slice(0, 240) || "HTML body with no JSON",
      });
    }
    try {
      body = JSON.parse(trimmed);
    } catch {
      throw new EndpointError("bad_response", {
        providerMessage: trimmed.slice(0, 240) || "non-JSON body",
      });
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EndpointError("bad_response", { providerMessage: "non-object decision body" });
  }
  const raw = body as {
    answers?: Record<string, unknown>;
    usage?: unknown;
    model?: string;
  };
  if (!raw.answers || typeof raw.answers !== "object" || Array.isArray(raw.answers)) {
    throw new EndpointError("bad_response", { providerMessage: "response missing answers" });
  }
  const answers: Record<string, Answer> = {};
  for (const [id, value] of Object.entries(raw.answers)) {
    answers[id] = normalizeAnswer(value);
  }
  if (questionCount > 0 && Object.keys(answers).length === 0) {
    throw new EndpointError("bad_response", { providerMessage: "empty answers object" });
  }
  return { answers, usage: usageFrom(raw.usage), model: raw.model };
};

const mapSdkError = (error: unknown): EndpointError => {
  if (isEndpointError(error)) return error;
  if (error instanceof RateLimitError) {
    return new EndpointError("rate_limit", {
      httpStatus: error.status,
      providerMessage: error.message,
      cause: error,
    });
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new EndpointError("auth", {
      httpStatus: error.status,
      providerMessage: error.message,
      cause: error,
    });
  }
  if (error instanceof NotFoundError) {
    return new EndpointError("not_found", {
      httpStatus: error.status,
      providerMessage: error.message,
      cause: error,
    });
  }
  if (error instanceof InternalServerError) {
    return new EndpointError("provider_outage", {
      httpStatus: error.status,
      providerMessage: error.message,
      cause: error,
    });
  }
  if (error instanceof APITimeoutError || error instanceof APIConnectionError) {
    return new EndpointError("unreachable", {
      providerMessage: error.message,
      cause: error,
    });
  }
  if (error instanceof APIError) {
    if (error.status === 402) {
      return new EndpointError("no_credits", {
        httpStatus: 402,
        providerMessage: error.message,
        cause: error,
      });
    }
    return classifyProviderError(error);
  }
  return classifyProviderError(error);
};

const decideWithTypeSafe = async (
  client: TypeSafeClient,
  state: EntryType,
  questions: Questions,
  model: string,
  trace: Trace,
): Promise<DecisionResult> => {
  const payload = { model, state, questions };
  const started = Date.now();
  try {
    const response = await client.systemOne(payload);
    const parsed = parseDecisionBody(response, Object.keys(questions).length);
    trace.record({
      kind: "request",
      name: "typesafe.systemOne",
      ms: Date.now() - started,
      ok: true,
      endpoint: "/v1/systemone",
      payload,
      response,
    });
    return parsed;
  } catch (error) {
    const mapped = mapSdkError(error);
    trace.record({
      kind: "request",
      name: "typesafe.systemOne",
      ms: Date.now() - started,
      ok: false,
      endpoint: "/v1/systemone",
      payload,
      error: mapped.summary,
    });
    throw mapped;
  }
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
  try {
    const response = await client.alpha.decisions.create({ decisionsRequest });
    const parsed = parseDecisionBody(response, Object.keys(questions).length);
    trace.record({
      kind: "request",
      name: "openrouter.decisions.create",
      ms: Date.now() - started,
      ok: true,
      endpoint: "/api/alpha/decisions",
      payload: decisionsRequest,
      response,
    });
    return parsed;
  } catch (error) {
    const mapped = mapSdkError(error);
    trace.record({
      kind: "request",
      name: "openrouter.decisions.create",
      ms: Date.now() - started,
      ok: false,
      endpoint: "/api/alpha/decisions",
      payload: decisionsRequest,
      error: mapped.summary,
    });
    throw mapped;
  }
};

/**
 * TypeSafeClient.systemOne first. Named endpoint faults are not retried on
 * OpenRouter, because the same proxy or key usually fails both paths.
 */
export const createJevClient = (config: JevConfig, trace: Trace = noTrace): JevClient => {
  const sdk = typesafeClient(config);
  return {
    async decide(state, questions, model = config.model) {
      try {
        return await decideWithTypeSafe(sdk, state, questions, model, trace);
      } catch (error) {
        if (isEndpointError(error)) throw error;
        if (config.provider === "openrouter" && config.apiKey) {
          try {
            return await decideWithOpenRouterSdk(config.apiKey, state, questions, model, trace);
          } catch (fallback) {
            throw mapSdkError(fallback);
          }
        }
        throw mapSdkError(error);
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
