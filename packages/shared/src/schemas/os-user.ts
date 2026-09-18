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


export const CreateOsUserInput = z.object({
  username: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*[$]?$/, "Invalid Linux username format"),
  password: z.string().min(1).max(128).optional(),
  shell: z.string().default("/bin/bash").optional(),
  homeDir: z.string().optional(),
  createHome: z.boolean().default(true).optional(),
  groups: z.array(z.string()).optional(),
  isSystemUser: z.boolean().default(false).optional(),
  uid: z.number().int().positive().optional(),
  gid: z.number().int().positive().optional(),
  sudoType: z.enum(["none", "all_nopasswd", "all_passwd", "custom"]).default("none").optional(),
  customCommands: z.array(z.string()).optional(),
});
export type CreateOsUserInput = z.infer<typeof CreateOsUserInput>;

export const UpdateOsUserInput = z.object({
  shell: z.string().optional(),
  homeDir: z.string().optional(),
  groups: z.array(z.string()).optional(),
  password: z.string().min(1).max(128).optional(),
  isLocked: z.boolean().optional(),
  sudoType: z.enum(["none", "all_nopasswd", "all_passwd", "custom"]).optional(),
  customCommands: z.array(z.string()).optional(),
});
export type UpdateOsUserInput = z.infer<typeof UpdateOsUserInput>;

export const DeleteOsUserInput = z.object({
  removeHome: z.boolean().default(true).optional(),
  force: z.boolean().default(false).optional(),
});
export type DeleteOsUserInput = z.infer<typeof DeleteOsUserInput>;
