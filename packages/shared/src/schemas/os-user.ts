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

export const SudoPermissionInput = z.object({
  username: z.string().min(1),
  permissionType: z.enum(["none", "all_nopasswd", "all_passwd", "custom"]),
  customCommands: z.array(z.string()).optional(),
});
export type SudoPermissionInput = z.infer<typeof SudoPermissionInput>;
