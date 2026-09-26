import type { AlertChannelType } from "@inv/shared";
import { decryptSecretDetailed, encryptSecret } from "../../lib/crypto.js";
import type { ChannelSecret } from "./types.js";

/**
 * Channel secrets at rest: one v3 `encryptSecret` blob of a small JSON object.
 *
 * v3, not the vault's v2: deliveries are sent by the background dispatcher,
 * which has no request and therefore no operator vault session. A v2 blob
 * would stop decrypting the moment the system vault session locked, and every
 * alert would silently fail. APP_ENCRYPTION_KEY is mandatory at boot, so v3 is
 * always openable here.
 */

export function sealChannelSecret(secret: ChannelSecret): string | null {
  const clean: ChannelSecret = {};
  if (secret.url) clean.url = secret.url;
  if (secret.routingKey) clean.routingKey = secret.routingKey;
  if (secret.botToken) clean.botToken = secret.botToken;
  if (secret.hmacSecret) clean.hmacSecret = secret.hmacSecret;
  if (secret.headers && Object.keys(secret.headers).length > 0) clean.headers = secret.headers;
  if (Object.keys(clean).length === 0) return null;
  return encryptSecret(JSON.stringify(clean));
}

export type OpenSecretResult = { ok: true; secret: ChannelSecret } | { ok: false; reason: string };

export function openChannelSecret(secretEnc: string | null): OpenSecretResult {
  if (!secretEnc) return { ok: true, secret: {} };
  const res = decryptSecretDetailed(secretEnc);
  if (!res.ok) {
    return {
      ok: false,
      reason:
        res.reason === "decryption-failed"
          ? "Channel secret does not decrypt (was APP_ENCRYPTION_KEY changed?) — re-enter it"
          : "Channel secret is in an unsupported format — re-enter it",
    };
  }
  try {
    const parsed = JSON.parse(res.plaintext) as ChannelSecret;
    return { ok: true, secret: parsed && typeof parsed === "object" ? parsed : {} };
  } catch {
    return { ok: false, reason: "Channel secret is corrupt — re-enter it" };
  }
}

function last4(s: string): string {
  return s.length <= 4 ? "••••" : s.slice(-4);
}

/** Masked, display-safe summary of the secret: enough to recognise, never enough to use. */
export function secretHintFor(type: AlertChannelType, secret: ChannelSecret): string | null {
  switch (type) {
    case "pagerduty":
      return secret.routingKey ? `routing key …${last4(secret.routingKey)}` : null;
    case "telegram":
      return secret.botToken ? `bot ${secret.botToken.split(":")[0] ?? "?"}:…${last4(secret.botToken)}` : null;
    case "email":
      return null;
    default: {
      if (!secret.url) return null;
      try {
        const u = new URL(secret.url);
        const tail = u.pathname.replace(/\/+$/, "");
        return `${u.protocol === "http:" ? "http://" : ""}${u.host}/…/${last4(tail.split("/").pop() ?? "")}`;
      } catch {
        return "…";
      }
    }
  }
}
