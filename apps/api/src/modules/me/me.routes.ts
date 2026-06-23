import { Hono } from "hono";
import { requireSession } from "../../middleware/session.js";
import { buildPermissionMap } from "../../lib/permissions.js";
import { env } from "../../env.js";

export const meRoutes = new Hono()
  .use(requireSession)
  .get("/", (c) => {
    const user = c.get("user");
    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      can: buildPermissionMap(user.role),
      features: { sshEnabled: env.SSH_ENABLED },
    });
  });
