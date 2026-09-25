import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Next } from "hono";

/**
 * A sudo password typed by the operator for ONE request (`X-Sudo-Password`).
 *
 * RackMap usually logs in with an SSH key, so the password stored for a server
 * is only ever exercised by sudo — and it can be stale or missing without
 * anyone noticing until a root action fails. The UI then asks for the sudo
 * password and retries with this header. It is never stored or logged, and it
 * only feeds sudo's stdin (execRemoteScript); SSH authentication is unchanged.
 * Background jobs have no request and therefore never see one.
 */
const sudoOverrideStorage = new AsyncLocalStorage<string | undefined>();

/** The operator-supplied sudo password for the in-flight request, if any. */
export function currentSudoPasswordOverride(): string | undefined {
  return sudoOverrideStorage.getStore();
}

function readSudoPassword(c: Context): string | undefined {
  const raw = c.req.header("x-sudo-password");
  // sudo -S reads one line; a newline would feed the rest to the script.
  if (!raw || raw.length > 1024 || /[\r\n\0]/.test(raw)) return undefined;
  return raw;
}

/** Middleware: run the rest of the request with the header's sudo password in scope. */
export async function withSudoOverride(c: Context, next: Next) {
  return sudoOverrideStorage.run(readSudoPassword(c), next);
}
