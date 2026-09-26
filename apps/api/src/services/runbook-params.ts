import {
  runbookParamNameError,
  validateRunbookParamValue,
  type RunbookParamDef,
} from "@inv/shared";
import { escapeShellArg } from "./shell-escape.js";

/**
 * How runbook parameters reach the script, and how secrets are kept out of the
 * stored output.
 *
 * Values are NEVER string-substituted into the script body and NEVER placed in
 * argv. They become `export NAME='…'` lines at the top of the uploaded file (see
 * remote-exec.service.ts: the file travels over stdin into a mktemp path), each
 * value quoted with escapeShellArg. Inside single quotes a POSIX shell interprets
 * nothing — `$(…)`, backticks, `;`, newlines and globs are all literal — and the
 * one character that can end the quoting, `'`, is rewritten to `'\''`.
 */

export class RunbookParamError extends Error {
  constructor(
    public param: string,
    message: string,
  ) {
    super(`Parameter ${param} ${message}`);
    this.name = "RunbookParamError";
  }
}

export interface PreludeContext {
  runId: number;
  serverId: number;
  hostname: string;
}

/**
 * Build the lines prepended to the script on each host.
 *
 * Every value is revalidated against its definition here, even though the API
 * validated it at request time: this is the last point before the value is
 * written into a file that runs — possibly as root — and the definition list is
 * the run's own snapshot, so a later edit to the runbook cannot change what is
 * accepted for a run that was already approved.
 */
export function buildPrelude(defs: RunbookParamDef[], values: Record<string, string>, ctx: PreludeContext): string {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const lines: string[] = [
    `export RACKMAP_RUN_ID=${escapeShellArg(String(ctx.runId))}`,
    `export RACKMAP_SERVER_ID=${escapeShellArg(String(ctx.serverId))}`,
    `export RACKMAP_HOSTNAME=${escapeShellArg(scrub(ctx.hostname))}`,
  ];

  for (const [name, value] of Object.entries(values)) {
    const def = byName.get(name);
    if (!def) throw new RunbookParamError(name, "is not defined by this runbook");
    const nameErr = runbookParamNameError(name);
    if (nameErr) throw new RunbookParamError(name, nameErr);
    const check = validateRunbookParamValue(def, value);
    if (!check.ok) throw new RunbookParamError(name, check.error);
    lines.push(`export ${name}=${escapeShellArg(check.value)}`);
  }

  // The offset lets an operator map an interpreter error ("line 12") back to the
  // runbook's own line numbers: script line = reported line - offset.
  const offset = lines.length + 1;
  lines.push(`# ---- runbook script (line offset ${offset}) ----`);
  return lines.join("\n") + "\n";
}

/** The full file uploaded to one host: prelude, then the script verbatim. */
export function composeRunbookScript(prelude: string, script: string): string {
  return prelude + script + (script.endsWith("\n") ? "" : "\n");
}

/** Hostnames come from the inventory; strip anything a shell file cannot hold. */
function scrub(s: string): string {
  return s.replace(/\u0000/g, "");
}

// ─── Secret masking ──────────────────────────────────────────────────────────

export const SECRET_MASK = "***";

export interface SecretMasker {
  /** Feed one chunk; returns the text that is now safe to persist. */
  push(chunk: string): string;
  /** End of stream: returns whatever was held back, masked. */
  flush(): string;
}

/**
 * Replace secret values in streamed output before it is stored.
 *
 * Output arrives in arbitrary chunks, so a secret can be split across two of
 * them ("hunter" | "2"). The masker therefore holds back the last
 * `maxSecretLength - 1` characters of every chunk: a secret that starts inside
 * that tail might continue in the next chunk, while one that starts before it is
 * guaranteed to be fully visible already. Among secrets starting at the same
 * position the longest wins, so a secret that is a prefix of another cannot leave
 * the remainder of the longer one exposed.
 */
export function createSecretMasker(secretValues: string[]): SecretMasker {
  const secrets = [...new Set(secretValues.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  if (secrets.length === 0) {
    return { push: (chunk) => chunk, flush: () => "" };
  }
  const hold = secrets[0]!.length - 1;
  let pending = "";

  function nextMatch(s: string, from: number): { idx: number; len: number } | null {
    let best: { idx: number; len: number } | null = null;
    for (const secret of secrets) {
      const idx = s.indexOf(secret, from);
      if (idx === -1) continue;
      // `secrets` is sorted longest-first, so a tie on idx keeps the longer one.
      if (!best || idx < best.idx) best = { idx, len: secret.length };
    }
    return best;
  }

  function mask(s: string, limit: number): { out: string; consumed: number } {
    let out = "";
    let pos = 0;
    for (;;) {
      const m = nextMatch(s, pos);
      if (!m || m.idx >= limit) break;
      out += s.slice(pos, m.idx) + SECRET_MASK;
      pos = m.idx + m.len;
    }
    const emitTo = Math.max(pos, limit);
    out += s.slice(pos, emitTo);
    return { out, consumed: emitTo };
  }

  return {
    push(chunk) {
      const s = pending + chunk;
      const { out, consumed } = mask(s, Math.max(0, s.length - hold));
      pending = s.slice(consumed);
      return out;
    },
    flush() {
      const { out } = mask(pending, pending.length);
      pending = "";
      return out;
    },
  };
}
