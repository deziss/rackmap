import { z } from "zod";

/** Excel/CSV column header -> server field mapping chosen in the wizard. */
export const ImportMapping = z.record(z.string(), z.string());

export const ImportRowError = z.object({
  row: z.number().int(),
  field: z.string().nullable(),
  message: z.string(),
});
export type ImportRowError = z.infer<typeof ImportRowError>;

export const ImportResult = z.object({
  dryRun: z.boolean(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  created: z.number().int(),
  lookupsCreated: z.record(z.string(), z.number().int()),
  errors: z.array(ImportRowError),
});
export type ImportResult = z.infer<typeof ImportResult>;
