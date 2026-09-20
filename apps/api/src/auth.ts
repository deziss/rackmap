import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { ac, roles } from "@inv/shared";
import { writeAuditDirect } from "./lib/audit.js";

// Better Auth otherwise infers the cookie "secure" flag from baseURL. Set it explicitly so an
// https deployment always gets Secure session cookies, including when BETTER_AUTH_URL is left
// at an internal http:// value behind a TLS-terminating proxy that serves an https WEB_ORIGIN.
const useSecureCookies =
  env.BETTER_AUTH_URL.startsWith("https://") || env.WEB_ORIGIN.startsWith("https://");

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // TRUSTED_ORIGINS defaults to WEB_ORIGIN (see env.ts). "*" is an explicit opt-in wildcard that
  // makes validateOrigin accept everything — env.ts warns loudly at boot when it is in effect.
  trustedOrigins:
    env.TRUSTED_ORIGINS === "*"
      ? ["*"]
      : env.TRUSTED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),

  emailAndPassword: {
    enabled: true,
    // Self-signup is off unless ALLOW_SELF_SIGNUP=true; admins create accounts instead.
    // When it is on, the admin plugin assigns "viewer" as the default role.
    disableSignUp: !env.ALLOW_SELF_SIGNUP,
    minPasswordLength: 8,
    autoSignIn: true,
  },

  session: {
    // The cookie cache lets Better Auth reconstruct a session from a signed
    // cookie without a DB read. Banning a user deletes their DB sessions but
    // cannot invalidate an already-issued cache entry, so the window here is
    // how long a ban or role downgrade could go unnoticed on paths that use
    // the cache. requireSession passes disableCookieCache, so authenticated
    // API routes always read through; this window applies to Better Auth's own
    // endpoints only. Kept short regardless.
    cookieCache: { enabled: true, maxAge: 60 },
  },

  advanced: {
    useSecureCookies,
    ipAddress: {
      // Better Auth keys its rate limiter on the client IP. By default it reads
      // X-Forwarded-For with no proxy-trust check, so rotating that header gives
      // an attacker an unlimited sign-in bucket. Only honour forwarding headers
      // when the operator has declared there is a trusted proxy in front.
      ipAddressHeaders: env.TRUST_PROXY ? ["x-forwarded-for", "x-real-ip"] : [],
    },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
    },
  },

  plugins: [
    admin({
      ac,
      roles,
      defaultRole: "viewer",
    }),
    twoFactor(),
  ],

  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await prisma.notificationPreference.create({
            data: { userId: user.id },
          }).catch((err) => console.error("[auth] failed to create default pref:", err));

          const { notifyUserRegistered } = await import("./services/notify.service.js");
          notifyUserRegistered({ id: user.id, email: user.email, name: user.name || "User" }).catch((err) => console.error("[notify] failed:", err));

          await writeAuditDirect({
            ctx: { actorId: user.id, actorEmail: user.email, ip: null },
            category: "auth",
            action: "user.create",
            entity: "User",
            entityId: user.id,
            after: { email: user.email },
          });
        },
      },
    },
  },
});

export type Auth = typeof auth;
