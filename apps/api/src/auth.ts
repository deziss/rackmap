import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { ac, roles } from "@inv/shared";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_ORIGIN],

  emailAndPassword: {
    enabled: true,
    // Signup disabled — admin creates users via /api/auth/admin/create-user
    disableSignUp: true,
    minPasswordLength: 8,
    autoSignIn: false,
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

  // Auth event audit hooks wired in M4 (writeAuditAuthEvent added after audit.ts created)
});

export type Auth = typeof auth;
