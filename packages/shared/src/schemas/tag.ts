import { z } from "zod";

export const TagCreateInput = z.object({
  name: z.string().trim().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});
export type TagCreateInput = z.infer<typeof TagCreateInput>;

export const TagDto = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string().nullable(),
  serverCount: z.number().int(),
});
export type TagDto = z.infer<typeof TagDto>;
