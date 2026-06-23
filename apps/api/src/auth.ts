import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { ac, roles } from "@inv/shared";
import { writeAuditDirect } from "./lib/audit.js";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // "*" = wildcard (allows any origin) — safe for internal tools on private networks
  trustedOrigins: env.TRUSTED_ORIGINS === "*" ? ["*"] : env.TRUSTED_ORIGINS.split(",").map((o) => o.trim()),

  emailAndPassword: {
    enabled: true,
    // Self-signup enabled; admin plugin assigns "viewer" as default role
    disableSignUp: false,
    minPasswordLength: 8,
    autoSignIn: true,
  },

  session: {
    cookieCache: { enabled: true, maxAge: 5 * 60 },
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
