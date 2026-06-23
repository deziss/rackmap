import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireSession } from "../../middleware/session.js";
import { prisma } from "../../db.js";

const updatePreferencesSchema = z.object({
  newServerAdded: z.boolean().optional(),
  serverUpDown: z.boolean().optional(),
  gpuCountChanged: z.boolean().optional(),
  diskUnmounted: z.boolean().optional(),
  diskFull: z.boolean().optional(),
  ramFull: z.boolean().optional(),
  highCpu: z.boolean().optional(),
  userRegistered: z.boolean().optional(),
});

export const preferencesRoutes = new Hono()
  .use(requireSession)
  .get("/", async (c) => {
    const user = c.get("user");
    let pref = await prisma.notificationPreference.findUnique({
      where: { userId: user.id },
    });
    
    if (!pref) {
      pref = await prisma.notificationPreference.create({
        data: { userId: user.id },
      });
    }

    return c.json(pref);
  })
  .patch("/", zValidator("json", updatePreferencesSchema), async (c) => {
    const user = c.get("user");
    const updates = c.req.valid("json");

    if (user.role !== "admin" && updates.userRegistered !== undefined) {
      // Non-admins can't opt into admin alerts
      delete updates.userRegistered;
    }

    const pref = await prisma.notificationPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...updates },
      update: updates,
    });

    return c.json(pref);
  });
