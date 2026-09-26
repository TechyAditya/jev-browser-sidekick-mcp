import { realpathSync, statSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const MAX_BYTES = 64_000;

export interface FileAllowlist {
  roots: string[];
  explicit: string[];
}

const isInside = (root: string, candidate: string): boolean => {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
};

const SECRET_NAME = /(?:^|[\\/])\.env(?:\..+)?$/i;

const resolveSafe = (path: string, allow: FileAllowlist): string => {
  const absolute = resolve(path);
  const real = realpathSync(absolute);
  const explicit = allow.explicit.map((p) => realpathSync(resolve(p)));
  if (SECRET_NAME.test(real) && !explicit.includes(real)) {
    throw new Error(`Refusing to read ${path} unless it is listed in contextPaths.`);
  }
  const allowed = [...explicit, ...allow.roots];
  if (allowed.some((root) => isInside(root, real))) return real;
  throw new Error(`File is outside the allowlist: ${path}`);
};

export const buildAllowlist = (
  cwd: string,
  contextPaths: string[] = [],
): FileAllowlist => {
  const roots = [realpathSync(cwd)];
  const explicit: string[] = [];
  for (const path of contextPaths) {
    try {
      const real = realpathSync(resolve(cwd, path));
      explicit.push(real);
      roots.push(dirname(real));
    } catch {
      // skip missing paths; the agent will see they are unavailable
    }
  }
  return { roots: [...new Set(roots)], explicit: [...new Set(explicit)] };
};

export const readAllowedFile = (
  path: string,
  allow: FileAllowlist,
): { path: string; text: string; truncated: boolean } => {
  const real = resolveSafe(path, allow);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  const buf = readFileSync(real);
  const truncated = buf.length > MAX_BYTES;
  const text = buf.subarray(0, MAX_BYTES).toString("utf8");
  return { path: real, text, truncated };
};

export const looksLikePath = (value: string): boolean =>
  /(?:^|[\\/])[^\\/:*?"<>|\n]+\.[A-Za-z0-9]{1,8}$/.test(value) ||
  /^[A-Za-z]:[\\/]/.test(value) ||
  value.startsWith("./") ||
  value.startsWith("../");
