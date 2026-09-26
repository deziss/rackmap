import { z } from "zod";

/**
 * Time-boxed access grants: a temporary OS account or a temporary SSH key on one
 * server, which RackMap revokes automatically when it expires.
 *
 * Two independent clocks enforce the expiry:
 *   1. RackMap's sweeper revokes the grant at `expiresAt` (lock / delete the
 *      account, or remove the key line from authorized_keys).
 *   2. The host itself, as defence in depth for when RackMap is down or cannot
 *      reach it: `chage -E` for accounts and an `expiry-time=` option for keys.
 *      Both are rounded so the host never cuts access EARLIER than RackMap.
 *
 * Every value that reaches the host is re-validated in
 * apps/api/src/services/access-grant*.ts; these schemas are the first gate.
 */

export const ACCESS_GRANT_KINDS = ["os_user", "ssh_key"] as const;
export const AccessGrantKind = z.enum(ACCESS_GRANT_KINDS);
export type AccessGrantKind = z.infer<typeof AccessGrantKind>;

/**
 * active          — access is live (or expired and waiting for the sweeper / a retry)
 * expired_pending — claimed by a revoke that is running right now
 * revoked         — access removed from the host
 * failed          — revocation failed ACCESS_GRANT_MAX_REVOKE_ATTEMPTS times; an alert was raised
 */
export const ACCESS_GRANT_STATUSES = ["active", "expired_pending", "revoked", "failed"] as const;
export const AccessGrantStatus = z.enum(ACCESS_GRANT_STATUSES);
export type AccessGrantStatus = z.infer<typeof AccessGrantStatus>;

/** lock / delete apply to temporary accounts, remove to temporary keys. */
export const ACCESS_GRANT_ON_EXPIRY = ["lock", "delete", "remove"] as const;
export const AccessGrantOnExpiry = z.enum(ACCESS_GRANT_ON_EXPIRY);
export type AccessGrantOnExpiry = z.infer<typeof AccessGrantOnExpiry>;

export const TemporaryUserOnExpiry = z.enum(["lock", "delete"]);
export type TemporaryUserOnExpiry = z.infer<typeof TemporaryUserOnExpiry>;

/** A grant may run at most 90 days from the moment it is created or extended. */
export const ACCESS_GRANT_MAX_DURATION_MS = 90 * 24 * 3600 * 1000;
/** Anything shorter than a minute is a typo or a skewed clock, not a grant. */
export const ACCESS_GRANT_MIN_DURATION_MS = 60 * 1000;
/** After this many failed revocations the grant is marked failed and a critical alert fires. */
export const ACCESS_GRANT_MAX_REVOKE_ATTEMPTS = 5;
/** Marker appended to every authorized_keys line RackMap writes: `rackmap-grant:<grantId>`. */
export const ACCESS_GRANT_KEY_MARKER_PREFIX = "rackmap-grant:";

/**
 * Groups that make an account root-equivalent. A UI hint only: it mirrors
 * PRIVILEGED_OS_GROUPS in apps/api/src/services/os-user.service.ts, which is the
 * list the API actually enforces.
 */
export const ACCESS_GRANT_PRIVILEGED_GROUPS = ["sudo", "wheel", "admin", "docker", "lxd", "disk", "root", "adm", "shadow"] as const;

export const ACCESS_GRANT_DURATION_PRESETS = [
  { id: "1h", label: "1 hour", ms: 3600 * 1000 },
  { id: "8h", label: "8 hours", ms: 8 * 3600 * 1000 },
  { id: "1d", label: "1 day", ms: 24 * 3600 * 1000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 3600 * 1000 },
] as const;

/** Why `expiresAt` is not an acceptable expiry, or null when it is. */
export function accessGrantExpiryError(expiresAt: Date, now: Date = new Date()): string | null {
  const t = expiresAt.getTime();
  if (Number.isNaN(t)) return "Expiry must be a valid date and time";
  if (t < now.getTime() + ACCESS_GRANT_MIN_DURATION_MS) return "Expiry must be at least one minute in the future";
  if (t > now.getTime() + ACCESS_GRANT_MAX_DURATION_MS) return "Expiry may be at most 90 days from now";
  return null;
}

// ─── Public keys ─────────────────────────────────────────────────────────────

/** Key types accepted for a temporary key (what `ssh-keygen -t` produces today). */
export const TEMPORARY_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;
export type TemporaryKeyType = (typeof TEMPORARY_KEY_TYPES)[number];

export const TEMPORARY_KEY_MAX_LENGTH = 16 * 1024;
const KEY_COMMENT_MAX = 200;

// type SP base64 [SP comment]. The line must START with the key type, so an
// authorized_keys option prefix (`command="…" ssh-ed25519 …`, `from=…`,
// `environment=…`) can never be smuggled in; RackMap writes the only option.
const KEY_LINE_PATTERN = /^(\S+) ([A-Za-z0-9+/]+={0,2})(?: (.*))?$/;
// Printable, shell- and sshd-inert characters only: no quotes, backslashes, `$`, `#`.
const KEY_COMMENT_PATTERN = /^[A-Za-z0-9._@+=:,/ -]*$/;

export interface ParsedTemporaryPublicKey {
  type: TemporaryKeyType;
  /** The base64 key blob, exactly as supplied. */
  body: string;
  /** Optional comment ("alice@laptop"); never contains the RackMap marker. */
  comment: string | null;
  /** Normalised `type body[ comment]`. */
  line: string;
}

/**
 * Structural validation of a pasted public key: one line, an allowed type, a
 * base64 body, an optional comment of safe characters, no options. The API
 * additionally decodes the blob and checks that it carries the declared type.
 */
export function parseTemporaryPublicKey(raw: string): { ok: true; key: ParsedTemporaryPublicKey } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "A public key is required" };
  if (raw.length > TEMPORARY_KEY_MAX_LENGTH) return { ok: false, error: "The public key is too long (maximum 16 KB)" };
  // A pasted key usually ends with a newline; surrounding whitespace is dropped,
  // anything inside the line is not.
  const value = raw.trim();
  if (/[\r\n\0]/.test(value)) return { ok: false, error: "Paste exactly one public key, on a single line" };
  if (/\t/.test(value)) return { ok: false, error: "Separate the key type, key and comment with single spaces" };

  const first = value.split(" ", 1)[0] ?? "";
  if (!(TEMPORARY_KEY_TYPES as readonly string[]).includes(first)) {
    if (/[=",]/.test(first) || /^(?:no-|restrict|cert-authority|principals|permit)/.test(first)) {
      return { ok: false, error: "Key options (command=, from=, no-pty, …) are not allowed; paste the bare public key" };
    }
    return { ok: false, error: `Unsupported key type; the key must start with one of ${TEMPORARY_KEY_TYPES.join(", ")}` };
  }
  const m = KEY_LINE_PATTERN.exec(value);
  if (!m) {
    return { ok: false, error: 'Expected "<type> <base64 key> [comment]", e.g. "ssh-ed25519 AAAAC3Nza… alice@laptop"' };
  }
  const [, type, body, rawComment] = m as unknown as [string, string, string, string | undefined];
  if (body.length < 32 || body.length % 4 !== 0) return { ok: false, error: "The key body is not valid base64" };

  const comment = rawComment === undefined ? null : rawComment.trim() || null;
  if (comment !== null) {
    if (comment.length > KEY_COMMENT_MAX) return { ok: false, error: `The key comment is too long (maximum ${KEY_COMMENT_MAX} characters)` };
    if (!KEY_COMMENT_PATTERN.test(comment)) {
      return { ok: false, error: "The key comment may contain letters, digits, spaces and . _ @ + = : , / - only" };
    }
    if (comment.toLowerCase().includes(ACCESS_GRANT_KEY_MARKER_PREFIX.slice(0, -1))) {
      return { ok: false, error: `The key comment may not contain "${ACCESS_GRANT_KEY_MARKER_PREFIX.slice(0, -1)}"` };
    }
  }

  const key: ParsedTemporaryPublicKey = {
    type: type as TemporaryKeyType,
    body,
    comment,
    line: comment ? `${type} ${body} ${comment}` : `${type} ${body}`,
  };
  return { ok: true, key };
}

export const TemporaryPublicKey = z
  .string()
  .max(TEMPORARY_KEY_MAX_LENGTH, "The public key is too long (maximum 16 KB)")
  .superRefine((v, ctx) => {
    const r = parseTemporaryPublicKey(v);
    if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
  })
  .transform((v) => v.trim());

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Mirrors CreateOsUserInput's username rule (useradd's NAME_REGEX, max 32). */
const GrantUsername = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/, "Invalid Linux username format");

/** ISO-8601 timestamp with an offset; must be ≥ 1 minute and ≤ 90 days ahead. */
export const AccessGrantExpiresAt = z
  .string()
  .trim()
  .max(64)
  .superRefine((v, ctx) => {
    const d = new Date(v);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Expiry must be an ISO-8601 date and time" });
      return;
    }
    const err = accessGrantExpiryError(d);
    if (err) ctx.addIssue({ code: "custom", message: err });
  });

const GrantReason = z.string().trim().min(1, "Give a reason for the grant").max(500);

const AccountPassword = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\r\n\0]*$/, "Password must not contain line breaks");

const GroupName = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/, "Invalid Linux group name");

const ShellPath = z
  .string()
  .trim()
  .max(255)
  .regex(/^$|^\/[A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9._@+-]+)*$/, "Shell must be an absolute path, e.g. /bin/bash");

const SudoCommand = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^(?!.*\b(?:ALL|NOPASSWD|PASSWD|SETENV|NOSETENV|EXEC|NOEXEC|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW)\b)\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*(?: [A-Za-z0-9._@+/-]+)*$/,
    'Each sudo command must be an absolute command path with plain arguments, e.g. "/usr/bin/systemctl restart nginx"',
  );

/** POST /access-grants/users — a new account that is locked or deleted on expiry. */
export const TemporaryUserCreateInput = z.object({
  serverId: z.number().int().positive(),
  username: GrantUsername,
  password: AccountPassword.optional(),
  shell: ShellPath.optional(),
  groups: z.array(GroupName).max(32).optional(),
  /** A sudo rule or a privileged group needs server:sudo, exactly as on the OS-users tab. */
  sudoType: z.enum(["none", "all_nopasswd", "all_passwd", "custom"]).optional(),
  customCommands: z.array(SudoCommand).max(32).optional(),
  expiresAt: AccessGrantExpiresAt,
  onExpiry: TemporaryUserOnExpiry.default("lock"),
  reason: GrantReason,
});
export type TemporaryUserCreateInput = z.infer<typeof TemporaryUserCreateInput>;

/** POST /access-grants/keys — a public key added to an existing account's authorized_keys. */
export const TemporaryKeyCreateInput = z.object({
  serverId: z.number().int().positive(),
  username: GrantUsername,
  publicKey: TemporaryPublicKey,
  expiresAt: AccessGrantExpiresAt,
  reason: GrantReason,
});
export type TemporaryKeyCreateInput = z.infer<typeof TemporaryKeyCreateInput>;

export const AccessGrantExtendInput = z.object({
  expiresAt: AccessGrantExpiresAt,
});
export type AccessGrantExtendInput = z.infer<typeof AccessGrantExtendInput>;

export const AccessGrantListQuery = z.object({
  serverId: z.coerce.number().int().positive().optional(),
  status: AccessGrantStatus.optional(),
  kind: AccessGrantKind.optional(),
});
export type AccessGrantListQuery = z.infer<typeof AccessGrantListQuery>;

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface AccessGrantUserRef {
  id: string;
  name: string;
  email: string;
}

export interface AccessGrantDto {
  id: number;
  serverId: number;
  server: { id: number; hostname: string; ip: string } | null;
  kind: AccessGrantKind;
  username: string;
  /** OpenSSH SHA256 fingerprint ("SHA256:…") for ssh_key grants. */
  keyFingerprint: string | null;
  onExpiry: AccessGrantOnExpiry;
  reason: string | null;
  expiresAt: string;
  status: AccessGrantStatus;
  attempts: number;
  lastError: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: AccessGrantUserRef | null;
  revokedBy: AccessGrantUserRef | null;
  /** Whether the CALLER may extend / revoke this grant (creator or accessGrant:revoke). */
  canExtend: boolean;
  canRevoke: boolean;
}

export interface AccessGrantListResponse {
  items: AccessGrantDto[];
}

export interface AccessGrantMutationResponse {
  grant: AccessGrantDto;
  /** Non-fatal problems, e.g. the host-side expiry could not be set. */
  warnings: string[];
}
