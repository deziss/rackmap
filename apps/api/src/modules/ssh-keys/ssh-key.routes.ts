import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireSession } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { AddSshKeyInput } from "@inv/shared";
import { listSshKeys, addSshKey, removeSshKey, testServerSshKey } from "../../services/ssh-key.service.js";

export const sshKeyRoutes = new Hono()
  .use(requireSession)

  // GET /api/v1/ssh-keys — list all host keys and custom keys
  .get("/", async (c) => {
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
      try {
        const result = await addSshKey(input);
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
      try {
        const result = await removeSshKey(id as string);
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: { code: "KEY_ERROR", message: err.message } }, 400);
      }
    },
  )

  // POST /api/v1/ssh-keys/test-server/:serverId — test connectivity
  .post(
    "/test-server/:serverId",
    async (c) => {
      const serverId = parseInt(c.req.param("serverId"), 10);
      const res = await testServerSshKey(serverId);
      return c.json(res);
    },
  );
