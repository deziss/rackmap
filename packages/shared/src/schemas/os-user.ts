import { z } from "zod";

export const OsUserInfo = z.object({
  username: z.string(),
  uid: z.number(),
  gid: z.number(),
  homeDir: z.string(),
  shell: z.string(),
  isSystemUser: z.boolean(),
  groups: z.array(z.string()),
  hasSudo: z.boolean(),
  sudoRules: z.array(z.string()),
});
export type OsUserInfo = z.infer<typeof OsUserInfo>;

/**
 * Every field below is interpolated into a shell command that runs as root on a
 * managed host, so each one is pinned to a conservative format here. The same
 * rules are re-applied at the point of interpolation in
 * apps/api/src/services/os-user.service.ts, which must not rely on a particular
 * route having validated with these schemas.
 */

// Absolute path: /bin/bash, /usr/sbin/nologin, /home/alice. The empty string is
// accepted so a cleared form field still means "leave unchanged" — the service
// skips falsy values and never puts them on a command line.
export const OS_ABSOLUTE_PATH_PATTERN = /^$|^\/[A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9._@+-]+)*$/;

// Linux group name, following useradd/groupadd's NAME_REGEX.
export const OS_GROUP_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/;

/**
 * A single sudoers command specification: an absolute command path followed by
 * optional plain arguments.
 *
 * `visudo -cf` validates syntax, not intent, so this pattern is what stops a
 * caller from granting itself root. The charset excludes every shell
 * metacharacter plus every character that could restructure the generated rule
 * (`=`, `:`, `,`, `(`, `)`, `!`, wildcards), and the lookahead blocks `ALL` and
 * the sudoers tags.
 */
export const OS_SUDO_COMMAND_PATTERN =
  /^(?!.*\b(?:ALL|NOPASSWD|PASSWD|SETENV|NOSETENV|EXEC|NOEXEC|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW)\b)\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*(?: [A-Za-z0-9._@+/-]+)*$/;

const SudoCommandSpec = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    OS_SUDO_COMMAND_PATTERN,
    'Each sudo command must be an absolute command path with plain arguments, e.g. "/usr/bin/systemctl restart nginx"'
  );

const LinuxShell = z
  .string()
  .trim()
  .max(255)
  .regex(OS_ABSOLUTE_PATH_PATTERN, "Shell must be an absolute path, e.g. /bin/bash");

const LinuxHomeDir = z
  .string()
  .trim()
  .max(255)
  .regex(OS_ABSOLUTE_PATH_PATTERN, "Home directory must be an absolute path, e.g. /home/alice");

const LinuxGroupName = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(OS_GROUP_NAME_PATTERN, "Invalid Linux group name");

/**
 * An account password for chpasswd, which reads `user:password` LINES: a line
 * break would start a second entry and could set any account's password.
 */
const OsAccountPassword = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\r\n\0]*$/, "Password must not contain line breaks");

export const SudoPermissionInput = z.object({
  username: z.string().min(1),
  permissionType: z.enum(["none", "all_nopasswd", "all_passwd", "custom"]),
  customCommands: z.array(SudoCommandSpec).optional(),
});
export type SudoPermissionInput = z.infer<typeof SudoPermissionInput>;


export const CreateOsUserInput = z.object({
  username: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/, "Invalid Linux username format"),
  password: OsAccountPassword.optional(),
  shell: LinuxShell.default("/bin/bash").optional(),
  homeDir: LinuxHomeDir.optional(),
  createHome: z.boolean().default(true).optional(),
  groups: z.array(LinuxGroupName).optional(),
  isSystemUser: z.boolean().default(false).optional(),
  uid: z.number().int().positive().optional(),
  gid: z.number().int().positive().optional(),
  sudoType: z.enum(["none", "all_nopasswd", "all_passwd", "custom"]).default("none").optional(),
  customCommands: z.array(SudoCommandSpec).optional(),
});
export type CreateOsUserInput = z.infer<typeof CreateOsUserInput>;

export const UpdateOsUserInput = z.object({
  shell: LinuxShell.optional(),
  homeDir: LinuxHomeDir.optional(),
  groups: z.array(LinuxGroupName).optional(),
  password: OsAccountPassword.optional(),
  isLocked: z.boolean().optional(),
  sudoType: z.enum(["none", "all_nopasswd", "all_passwd", "custom"]).optional(),
  customCommands: z.array(SudoCommandSpec).optional(),
});
export type UpdateOsUserInput = z.infer<typeof UpdateOsUserInput>;

/**
 * A boolean that arrives as a query-string value ("true" / "false").
 *
 * Deliberately NOT z.coerce.boolean(): that is Boolean(value), which turns the
 * string "false" into true — here it would silently run `userdel -f`. Anything
 * other than true / "true" is false.
 */
const QueryBoolean = z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true");

/** Validated from the DELETE query string. An omitted removeHome means "remove it" (the service default). */
export const DeleteOsUserInput = z.object({
  removeHome: QueryBoolean.optional(),
  force: QueryBoolean.optional(),
});
export type DeleteOsUserInput = z.infer<typeof DeleteOsUserInput>;
