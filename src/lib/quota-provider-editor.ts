import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseJsonOrJsonc } from "./jsonc.js";
import { isRecord, validateQuotaDefinitions } from "./quota-provider-definitions.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const LIMIT = 65536;
interface Token {
  value: string;
  start: number;
  end: number;
}
/** Token offsets let us change one array without serializing unrelated JSONC or comments. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < text.length; ) {
    if (/\s/u.test(text[i])) {
      i++;
      continue;
    }
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Invalid JSONC");
      i = end + 2;
      continue;
    }
    const start = i;
    if (text[i] === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i++] === '"') break;
      }
    } else if ("{}[]:,".includes(text[i])) i++;
    else {
      while (i < text.length && !/[\s{}\[\]:,]/u.test(text[i])) i++;
    }
    out.push({ value: text.slice(start, i), start, end: i });
  }
  return out;
}
function rootFields(text: string) {
  const ts = tokens(text);
  if (ts[0]?.value !== "{") throw new Error("Expected a JSONC object");
  const fields: Array<{ key: string; first: number; last: number }> = [];
  let i = 1;
  while (ts[i]?.value !== "}") {
    const key = JSON.parse(ts[i++]?.value) as string;
    if (ts[i++]?.value !== ":") throw new Error("Invalid JSONC field");
    const first = i;
    if (ts[i]?.value === "{" || ts[i]?.value === "[") {
      let depth = 0;
      do {
        const v = ts[i++]?.value;
        if (v === "{" || v === "[") depth++;
        else if (v === "}" || v === "]") depth--;
        if (i > ts.length) throw new Error("Invalid JSONC nesting");
      } while (depth);
    } else i++;
    fields.push({ key, first, last: i - 1 });
    if (ts[i]?.value === ",") i++;
    else if (ts[i]?.value !== "}") throw new Error("Invalid JSONC separator");
  }
  if (i !== ts.length - 1 || new Set(fields.map((f) => f.key)).size !== fields.length)
    throw new Error("Duplicate or invalid root fields");
  return { ts, fields, close: i };
}
function readTarget(path: string) {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const link = info?.isSymbolicLink() ? readlinkSync(path) : undefined;
  // Resolve an existing link, including a link to a directory; dangling links fail closed.
  const canonical = (candidate: string): string =>
    existsSync(candidate)
      ? realpathSync(candidate)
      : join(canonical(dirname(candidate)), basename(candidate));
  const target = info ? realpathSync(path) : canonical(path);
  const file = info ? statSync(target) : undefined;
  if (
    file &&
    (!file.isFile() || file.size > LIMIT || (process.getuid && file.uid !== process.getuid()))
  )
    throw new Error("Config must be a small user-owned regular file");
  const text = file ? readFileSync(target, "utf8") : "{}\n";
  if (Buffer.byteLength(text) > LIMIT) throw new Error("Config too large");
  return {
    target,
    text,
    mode: file ? file.mode & 0o777 : 0o600,
    identity: JSON.stringify([
      target,
      link,
      file?.dev,
      file?.ino,
      file?.mtimeMs,
      file?.mode,
      hash(text),
    ]),
    existed: !!file,
  };
}
export interface ProviderEditPlan {
  path: string;
  target: string;
  before: string;
  after: string;
  identity: string;
  mode: number;
  existed: boolean;
  digest: string;
  preview: string;
  changed: boolean;
}
export function prepareProviderAdd(path: string, input: unknown): ProviderEditPlan {
  path = resolve(path);
  const definition = validateQuotaDefinitions([input])[0];
  const base = readTarget(path);
  const root = parseJsonOrJsonc(base.text, true);
  if (!isRecord(root)) throw new Error("Config must be an object");
  const existing =
    root.quotaProviders === undefined ? [] : validateQuotaDefinitions(root.quotaProviders);
  const match = existing.find((d) => d.id === definition.id);
  if (match && JSON.stringify(match) !== JSON.stringify(definition))
    throw new Error("Provider ID already configured with a different definition");
  const { ts, fields, close } = rootFields(base.text);
  let after = base.text;
  if (!match) {
    validateQuotaDefinitions([...existing, definition]);
    const formatted = JSON.stringify(definition, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    const field = fields.find((f) => f.key === "quotaProviders");
    if (field) {
      if (ts[field.first].value !== "[") throw new Error("quotaProviders must be an array");
      const end = ts[field.last].start;
      const needsComma = field.last > field.first + 1 && ts[field.last - 1].value !== ",";
      // Add the separator beside the preceding value, never after a line comment.
      const separator = needsComma ? ts[field.last - 1].end : end;
      after =
        base.text.slice(0, separator) +
        (needsComma ? "," : "") +
        base.text.slice(separator, end) +
        `\n${formatted}\n  ` +
        base.text.slice(end);
    } else {
      const end = ts[close].start;
      const needsComma = fields.length > 0 && ts[close - 1].value !== ",";
      const separator = needsComma ? ts[close - 1].end : end;
      after =
        base.text.slice(0, separator) +
        (needsComma ? "," : "") +
        base.text.slice(separator, end) +
        `\n  "quotaProviders": [\n${formatted}\n  ]\n` +
        base.text.slice(end);
    }
  }
  if (Buffer.byteLength(after) > LIMIT) throw new Error("Updated config too large");
  const parsed = parseJsonOrJsonc(after, true);
  if (!isRecord(parsed)) throw new Error("Invalid updated config");
  validateQuotaDefinitions(parsed.quotaProviders);
  // The complete changed field is shown. Unrelated settings may contain credentials and never enter preview output.
  const beforeField = fields.find((f) => f.key === "quotaProviders");
  const next = rootFields(after);
  const afterField = next.fields.find((f) => f.key === "quotaProviders")!;
  const beforeValue = beforeField
    ? base.text.slice(ts[beforeField.first].start, ts[beforeField.last].end)
    : "(absent)";
  const afterValue = after.slice(next.ts[afterField.first].start, next.ts[afterField.last].end);
  return {
    path,
    target: base.target,
    before: base.text,
    after,
    identity: base.identity,
    mode: base.mode,
    existed: base.existed,
    digest: hash(base.identity + after),
    changed: after !== base.text,
    preview: `quotaProviders (complete changed field; other bytes preserved)\n--- before\n${beforeValue}\n+++ after\n${afterValue}`,
  };
}
function syncDir(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Cooperative lock and exact baseline recheck; uncooperative writers still require normal coordination. */
export function writeProviderPlan(
  plan: ProviderEditPlan,
  expectedDigest: string,
  beforeCommit?: () => void,
): { backup?: string; durabilityWarning?: boolean } {
  if (expectedDigest !== plan.digest)
    throw new Error("Preview changed; review the new preview before writing");
  if (!plan.changed) {
    if (readTarget(plan.path).identity !== plan.identity)
      throw new Error("Config changed since preview");
    return {};
  }
  mkdirSync(dirname(plan.target), { recursive: true, mode: 0o700 });
  const lock = `${plan.target}.provider.lock`;
  const lockFd = openSync(lock, "wx", 0o600);
  let temp: string | undefined;
  let backup: string | undefined;
  let committed = false;
  try {
    const verify = () => {
      if (readTarget(plan.path).identity !== plan.identity)
        throw new Error("Config changed since preview; nothing written");
    };
    verify();
    const tempPath = join(dirname(plan.target), `.quota-provider-${randomUUID()}.tmp`);
    const fd = openSync(tempPath, "wx", plan.mode);
    temp = tempPath;
    try {
      writeFileSync(fd, plan.after);
      chmodSync(temp, plan.mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (plan.existed) {
      const backupPath = `${plan.target}.before-provider-${randomUUID()}.bak`;
      const backupFd = openSync(backupPath, "wx", 0o600);
      backup = backupPath;
      try {
        writeFileSync(backupFd, plan.before);
        chmodSync(backup, 0o600);
        fsyncSync(backupFd);
      } finally {
        closeSync(backupFd);
      }
    }
    beforeCommit?.();
    verify();
    renameSync(temp, plan.target);
    temp = undefined;
    committed = true;
    try {
      syncDir(dirname(plan.target));
    } catch {
      return { backup, durabilityWarning: true };
    }
    return { backup };
  } finally {
    if (temp) unlinkSync(temp);
    if (!committed && backup) unlinkSync(backup);
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
