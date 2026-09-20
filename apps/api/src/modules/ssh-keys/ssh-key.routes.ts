import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { AddSshKeyInput } from "@inv/shared";
import { writeAudit } from "../../lib/audit.js";
import { listSshKeys, addSshKey, removeSshKey, testServerSshKey } from "../../services/ssh-key.service.js";

/** Body accepted by the connectivity test. Previously parsed as `any`. */
const TestServerInput = z.object({
  authMethod: z.enum(["auto", "key", "password"]).optional(),
  password: z.string().max(1024).optional(),
  keyId: z.string().max(256).optional(),
});

export const sshKeyRoutes = new Hono()
  .use(requireSession)

  // GET /api/v1/ssh-keys — list all host keys and custom keys
  .get("/", requirePermission({ server: ["update"] }), async (c) => {
    const keys = await listSshKeys();
    return c.json({ keys });
  })

  // POST /api/v1/ssh-keys — add a custom SSH key
  .post(
    "/",
    requirePermission({ server: ["update"] }),
    zValidator("json", AddSshKeyInput),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");
      try {
        const result = await addSshKey(input);
        await writeAudit({
          ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
          category: "security",
          action: "ssh_key.add",
          entity: "SshKey",
          entityId: result?.id,
          after: { name: input.name, id: result?.id },
        });
        return c.json(result, 201);
      } catch (err: any) {
        return c.json({ error: { code: "KEY_ERROR", message: err.message } }, 400);
      }
    },
  )

  // DELETE /api/v1/ssh-keys/:id — remove custom key
  .delete(
    "/:id",
    requirePermission({ server: ["delete"] }),
    async (c) => {
      const id = c.req.param("id");
      const user = c.get("user");
      try {
        const result = await removeSshKey(id as string);
        await writeAudit({
          ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
          category: "security",
          action: "ssh_key.remove",
          entity: "SshKey",
          entityId: id,
        });
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: { code: "KEY_ERROR", message: err.message } }, 400);
      }
    },
  )

  // POST /api/v1/ssh-keys/test-server/:serverId — test connectivity (key, password, or auto)
  .post(
    "/test-server/:serverId",
    requirePermission({ server: ["update"] }),
    async (c) => {
      const serverId = Number.parseInt(c.req.param("serverId") ?? "", 10);
      if (!Number.isInteger(serverId) || serverId <= 0) {
        return c.json({ error: { code: "BAD_REQUEST", message: "Invalid server id" } }, 400);
      }

      let raw: unknown = {};
      try {
        raw = await c.req.json();
      } catch {
        // empty body is fine
      }
      const parsed = TestServerInput.safeParse(raw ?? {});
      if (!parsed.success) {
        return c.json({ error: { code: "BAD_REQUEST", message: "Invalid request body" } }, 400);
      }

      const user = c.get("user");
      const res = await testServerSshKey(serverId, parsed.data);

      // Every credential test is an authentication attempt against a managed
      // host — record it so repeated failures are visible in the audit log.
      await writeAudit({
        ctx: { actorId: user?.id, actorEmail: user?.email, ip: c.req.header("x-forwarded-for") },
        category: "security",
        action: res.success ? "server.ssh_test_success" : "server.ssh_test_failed",
        entity: "Server",
        entityId: String(serverId),
        after: { authMethod: parsed.data.authMethod ?? "auto", success: res.success },
      });

      return c.json(res);
    },
  );
