/**
 * The policy for the FIRST administrator account, in one place.
 *
 * Two things enforce it and they must not drift: preflight.ts refuses to start
 * the container when the database is empty and the password is unusable (an
 * early warning, before migrations run), and prisma/seed.ts refuses at the
 * moment of creation (the authority — it is the only one that knows the
 * database is genuinely empty). The list and the predicate used to live inline
 * in seed.ts, where preflight could not see them.
 */

/**
 * Passwords that are published in this repository — the README, the compose
 * file, the seed itself. Creating the first admin with one of these hands a
 * working login to anyone who read the source.
 */
export const WEAK_DEFAULTS = new Set([
  "Admin123!",
  "changeme123",
  "Change-Me-Now-123!",
  "admin",
  "password",
]);

/** Shortest password accepted for the initial admin in production. */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * What seed.ts falls back to when SEED_ADMIN_PASSWORD is unset or blank. It is
 * in WEAK_DEFAULTS on purpose: in production the refusal below fires instead,
 * and only a development instance ever gets this account.
 */
export const DEV_DEFAULT_ADMIN_PASSWORD = "Admin123!";

/**
 * True when this value must not become the first admin's password.
 *
 * Blank counts. docker-compose.yml passes `SEED_ADMIN_PASSWORD: ${SEED_ADMIN_PASSWORD:-}`,
 * so an operator who never set it sends the empty string rather than nothing at
 * all — which is exactly the case `??` in seed.ts used to wave through.
 */
export function isWeakAdminPassword(password: string): boolean {
  if (password.trim().length === 0) return true;
  if (WEAK_DEFAULTS.has(password)) return true;
  return password.length < MIN_ADMIN_PASSWORD_LENGTH;
}

/**
 * Resolves SEED_ADMIN_PASSWORD to the password to actually use, substituting
 * the development default for an unset or blank value. Callers still have to
 * run isWeakAdminPassword() on the result — this only removes the empty case.
 */
export function resolveAdminPassword(raw: string | undefined): string {
  return raw !== undefined && raw.trim().length > 0 ? raw : DEV_DEFAULT_ADMIN_PASSWORD;
}
