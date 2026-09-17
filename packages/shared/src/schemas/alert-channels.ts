import { z } from "zod";

export const AlertChannelsInfo = z.object({
  webhook: z.object({
    configured: z.boolean(),
    urlMasked: z.string().nullable(),
  }),
  telegram: z.object({
    configured: z.boolean(),
    chatId: z.string().nullable(),
  }),
  email: z.object({
    configured: z.boolean(),
    host: z.string().nullable(),
  }),
});
export type AlertChannelsInfo = z.infer<typeof AlertChannelsInfo>;

export const TestAlertResponse = z.object({
  success: z.boolean(),
  message: z.string(),
  channels: z.object({
    webhook: z.boolean(),
    telegram: z.boolean(),
    email: z.boolean(),
  }),
});
export type TestAlertResponse = z.infer<typeof TestAlertResponse>;
