import { z } from "zod";
import { LOOKUP_TYPE_KEYS, type LookupType } from "../constants.js";

export const LookupTypeParam = z.object({
  type: z.enum(LOOKUP_TYPE_KEYS as [LookupType, ...LookupType[]]),
});
export type LookupTypeParam = z.infer<typeof LookupTypeParam>;

export const LookupCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
});
export type LookupCreateInput = z.infer<typeof LookupCreateInput>;

export const LookupUpdateInput = LookupCreateInput;
export type LookupUpdateInput = z.infer<typeof LookupUpdateInput>;

export const LookupDto = z.object({
  id: z.number().int(),
  name: z.string(),
  serverCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LookupDto = z.infer<typeof LookupDto>;
