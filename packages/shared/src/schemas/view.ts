import { z } from "zod";

export const SavedViewCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** Serialized servers-table search params + column visibility. */
  params: z.record(z.string(), z.unknown()),
});
export type SavedViewCreateInput = z.infer<typeof SavedViewCreateInput>;

export const SavedViewUpdateInput = SavedViewCreateInput.partial();
export type SavedViewUpdateInput = z.infer<typeof SavedViewUpdateInput>;

export const SavedViewDto = z.object({
  id: z.number().int(),
  name: z.string(),
  params: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type SavedViewDto = z.infer<typeof SavedViewDto>;
