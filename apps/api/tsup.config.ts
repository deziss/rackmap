import { defineConfig } from "tsup";

export default defineConfig({
  // preflight.ts is a second binary, not part of the app: the container runs
  // `node dist/preflight.js` before migrations so a bad .env or an unreachable
  // database is reported once, in its own words, instead of surfacing as a
  // Prisma failure three steps later.
  entry: ["src/index.ts", "src/preflight.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  noExternal: ["@inv/shared"],
});
