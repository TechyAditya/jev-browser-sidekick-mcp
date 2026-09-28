/**
 * Infrastructure faults from the Jev provider, distinct from a page that said
 * no. Callers branch on `reason`; the summary carries the HTTP status and a
 * short provider message.
 */

export const ENDPOINT_REASONS = [
  "rate_limit",
  "auth",
  "no_credits",
  "not_found",
  "provider_outage",
  "unreachable",
  "proxy_interstitial",
  "bad_response",
] as const;

export type EndpointReason = (typeof ENDPOINT_REASONS)[number];

export const isEndpointReason = (value: unknown): value is EndpointReason =>
  typeof value === "string" && (ENDPOINT_REASONS as readonly string[]).includes(value);

const LABEL: Record<EndpointReason, string> = {
  rate_limit: "rate limit exceeded",
  auth: "invalid or missing API key",
  no_credits: "no credits left",
  not_found: "model or endpoint not found",
  provider_outage: "provider outage",
  unreachable: "provider unreachable",
  proxy_interstitial: "HTTP proxy interstitial",
  bad_response: "non-JSON provider response",
};

const clipLines = (text: string, maxLines = 2, maxChars = 240): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  const joined = (lines.join(" ") || flat).slice(0, maxChars);
  return joined.length < (lines.join(" ") || flat).length ? `${joined}…` : joined;
};

const bodyText = (body: unknown): string => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    const row = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "msg"]) {
      const value = row[key];
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === "string") return nested;
      }
    }
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return String(body);
};

export class EndpointError extends Error {
  readonly reason: EndpointReason;
  readonly httpStatus?: number;
  readonly providerMessage: string;
  /** `blocked` only for a proxy interstitial the operator must clear. */
  readonly runStatus: "error" | "blocked";

  constructor(
    reason: EndpointReason,
    opts: { httpStatus?: number; providerMessage?: string; cause?: unknown } = {},
  ) {
    const detail = clipLines(opts.providerMessage ?? LABEL[reason]);
    const statusBit = opts.httpStatus !== undefined ? ` HTTP ${opts.httpStatus}` : "";
    const summary = `endpoint ${reason}:${statusBit} ${detail}`.replace(/\s+/g, " ").trim();
    super(summary, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "EndpointError";
    this.reason = reason;
    this.httpStatus = opts.httpStatus;
    this.providerMessage = detail;
    this.runStatus = reason === "proxy_interstitial" ? "blocked" : "error";
  }

  /** One-line summary for task results and handoffs. */
  get summary(): string {
    return this.message;
  }
}

export const isEndpointError = (error: unknown): error is EndpointError =>
  error instanceof EndpointError;

const hasStatus = (error: unknown): error is { status: number; body?: unknown; message?: string } =>
  Boolean(error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number");

const nameOf = (error: unknown): string =>
  error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";

/**
 * Map a thrown provider or parse failure to a named endpoint fault. Prefer
 * SDK error classes and HTTP status when present; fall back to the message.
 */
export const classifyProviderError = (error: unknown): EndpointError => {
  if (error instanceof EndpointError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status = hasStatus(error) ? error.status : undefined;
  const fromBody = hasStatus(error) ? bodyText(error.body) : "";
  const providerMessage = fromBody || message;

  if (
    /content-type.*text\/html|text\/html|returned html|doctype\s*<|<!doctype/i.test(message) ||
    /<!doctype|<html[\s>]/i.test(fromBody)
  ) {
    return new EndpointError("proxy_interstitial", {
      httpStatus: status ?? 200,
      providerMessage,
      cause: error,
    });
  }

  const name = nameOf(error);
  if (name === "RateLimitError" || status === 429 || /rate.?limit/i.test(lower)) {
    return new EndpointError("rate_limit", { httpStatus: status ?? 429, providerMessage, cause: error });
  }
  if (
    name === "AuthenticationError" ||
    name === "PermissionDeniedError" ||
    status === 401 ||
    status === 403 ||
    /invalid api key|incorrect api key|unauthorized|forbidden|authentication/i.test(lower)
  ) {
    return new EndpointError("auth", { httpStatus: status ?? 401, providerMessage, cause: error });
  }
  if (
    status === 402 ||
    /payment.?required|no credits|out of credits|insufficient.?credit|quota.?exceeded|billing/i.test(
      `${lower} ${fromBody.toLowerCase()}`,
    )
  ) {
    return new EndpointError("no_credits", { httpStatus: status ?? 402, providerMessage, cause: error });
  }
  if (name === "NotFoundError" || status === 404 || /model.?not.?found|endpoint.?not.?found/i.test(lower)) {
    return new EndpointError("not_found", { httpStatus: status ?? 404, providerMessage, cause: error });
  }
  if (name === "InternalServerError" || (status !== undefined && status >= 500)) {
    return new EndpointError("provider_outage", { httpStatus: status, providerMessage, cause: error });
  }
  if (
    name === "APITimeoutError" ||
    name === "APIConnectionError" ||
    name === "TimeoutError" ||
    /timed?\s*out|timeout|enotfound|econnrefused|econnreset|dns|getaddrinfo|fetch failed|network/i.test(
      lower,
    )
  ) {
    return new EndpointError("unreachable", { httpStatus: status, providerMessage, cause: error });
  }
  if (/non-json|missing answers|empty answers|non-object decision/i.test(lower)) {
    return new EndpointError("bad_response", { httpStatus: status, providerMessage, cause: error });
  }

  return new EndpointError("bad_response", { httpStatus: status, providerMessage, cause: error });
};
