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
  trustedOrigins: [env.WEB_ORIGIN],

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
