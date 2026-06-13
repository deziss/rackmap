import { createAuthClient } from "better-auth/react";
import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import { ac, roles } from "@inv/shared";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [adminClient({ ac, roles }), twoFactorClient()],
});

export type Session = typeof authClient.$Infer.Session;
