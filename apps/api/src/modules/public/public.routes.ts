import { Hono } from "hono";
import { env } from "../../env.js";

/**
 * Unauthenticated configuration the sign-in page needs before a session exists.
 *
 * Only advertise flags that change what the login UI should offer. Nothing here
 * may reveal deployment details — this endpoint is reachable by anyone who can
 * reach the API.
 */
export const publicRoutes = new Hono().get("/config", (c) =>
  c.json({
    allowSelfSignup: env.ALLOW_SELF_SIGNUP,
    // Online checkout only works with a payment backend; with BILLING_MODE
    // "disabled" the UI offers license-key activation instead.
    billingEnabled: env.BILLING_MODE === "simulated",
  }),
);
