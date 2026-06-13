import type { AppType } from "../app.js";

type Role = "admin" | "editor" | "viewer";

const passwords: Record<Role, string> = {
  admin: "Admin123!",
  editor: "Editor123!",
  viewer: "Viewer123!",
};

const emails: Record<Role, string> = {
  admin: "admin@inventory.local",
  editor: "editor@inventory.local",
  viewer: "viewer@inventory.local",
};

/** Sign in and return a cookie header string for subsequent requests. */
export async function loginAs(app: AppType, role: Role): Promise<string> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: emails[role], password: passwords[role] }),
  });
  if (!res.ok) {
    throw new Error(`loginAs(${role}) failed: ${res.status} ${await res.text()}`);
  }
  // Extract Set-Cookie header
  const raw = res.headers.get("set-cookie") ?? "";
  // Return as Cookie header value (strip directives)
  return raw
    .split(",")
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

export function authHeader(cookie: string) {
  return { Cookie: cookie };
}
