import type { AlertChannelType } from "@inv/shared";
import type { Formatter } from "../types.js";
import { slackFormatter } from "./slack.js";
import { teamsFormatter } from "./teams.js";
import { discordFormatter } from "./discord.js";
import { pagerdutyFormatter } from "./pagerduty.js";
import { telegramFormatter } from "./telegram.js";
import { webhookFormatter } from "./webhook.js";
import { emailFormatter } from "./email.js";

export const formatters: Record<AlertChannelType, Formatter> = {
  slack: slackFormatter,
  teams: teamsFormatter,
  discord: discordFormatter,
  pagerduty: pagerdutyFormatter,
  telegram: telegramFormatter,
  webhook: webhookFormatter,
  email: emailFormatter,
};

export function formatterFor(type: string): Formatter | null {
  return (formatters as Record<string, Formatter | undefined>)[type] ?? null;
}
