import { Hono } from "hono";
import { prisma } from "../../db.js";

export const healthRoutes = new Hono()
  .get("/live", (c) => c.json({ status: "ok" }))
  .get("/ready", async (c) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return c.json({ status: "ok", db: "ok" });
    } catch {
      return c.json({ status: "degraded", db: "unreachable" }, 503);
    }
  });
