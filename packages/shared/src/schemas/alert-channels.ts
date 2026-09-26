import { z } from "zod";
import { ServerAlertChannelDto } from "./alert-channel.js";

/**
 * Response of GET /servers/:id/alert-channels.
 *
 * The webhook/telegram/email blocks are the pre-channel shape (NOTIFY_* env and
 * SMTP) and stay so the old server card keeps rendering; `channels` is what the
 * new ServerAlertChannelsCard reads: every channel this server's alerts reach.
 */
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
  channels: z.array(ServerAlertChannelDto).optional(),
  /** Users whose notification preferences opt them into server up/down email. */
  preferenceEmailRecipients: z.number().int().optional(),
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
  /** The `test` AlertEvent that was queued, and how many channel deliveries it fanned out to. */
  eventId: z.number().int().optional(),
  queued: z.number().int().optional(),
});
export type TestAlertResponse = z.infer<typeof TestAlertResponse>;
