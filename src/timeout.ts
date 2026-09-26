export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Never await a browser or provider call without a ceiling. */
export const withTimeout = async <T>(
  work: Promise<T> | (() => Promise<T>),
  ms: number,
  label: string,
): Promise<T> => {
  const promise = typeof work === "function" ? work() : work;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export interface Deadline {
  /** Milliseconds left, never below zero. */
  left(): number;
  expired(): boolean;
  /** Cap a per-call timeout so it cannot outlive the run. */
  cap(ms: number): number;
}

export const createDeadline = (totalMs: number): Deadline => {
  const end = Date.now() + Math.max(1000, totalMs);
  const left = (): number => Math.max(0, end - Date.now());
  return {
    left,
    expired: () => left() === 0,
    cap: (ms) => Math.max(500, Math.min(ms, left() || 500)),
  };
};
