/**
 * Shell-safety helper shared by the services that build command strings and run
 * them over SSH on managed hosts — frequently as root, via `buildSudoCommand`.
 *
 * Any value that originates from an HTTP request MUST pass through
 * `escapeShellArg` (or a stricter, format-specific validator) before it is
 * interpolated into a command string.
 */

/**
 * Wrap a value in single quotes so the remote shell treats it as one literal
 * argument. Embedded single quotes are closed, escaped and reopened
 * (`'` becomes `'\''`) — the only sequence a POSIX shell cannot re-enter.
 */
export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
