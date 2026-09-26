import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Prisma } from "@prisma/client";
import {
  RunbookTargetSelector,
  isEmptyRunbookSelector,
  type RunbookTargetPreviewItem,
  type RunbookTargetWarning,
} from "@inv/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../lib/errors.js";
import { isSystemVaultUnlocked } from "./vault.service.js";

/**
 * Turning a runbook's target selector into a concrete, frozen list of servers.
 *
 * Semantics: the non-empty dimensions (tags, environments, locations) are ANDed
 * and the values inside one dimension are ORed, so `{tagIds:[1,2],
 * environments:["cloud"]}` means "tagged 1 or 2, AND in the cloud". Explicit
 * `serverIds` are unioned on top, then `excludeServerIds` is subtracted.
 *
 * An empty selector is rejected outright. Treating "nothing selected" as "every
 * server" is the classic way a fleet tool turns a half-filled form into an
 * outage, so there is no code path here that produces an unfiltered query.
 */

export interface ResolvedTargets {
  servers: {
    id: number;
    hostname: string;
    ip: string;
    environment: string | null;
    lastStatus: string;
    passwordEnc: string | null;
  }[];
  /** More servers matched than the cap; `servers` holds the first `maxTargets`. */
  exceeded: boolean;
  maxTargets: number;
}

export function emptySelectorError() {
  return new AppError(
    "VALIDATION_ERROR",
    "The target selector is empty. Select at least one server, tag, environment or location.",
    400,
  );
}

/** Parse a stored selector (Json column) defensively; legacy/garbage values become empty. */
export function parseStoredSelector(raw: unknown): RunbookTargetSelector {
  const parsed = RunbookTargetSelector.safeParse(raw ?? {});
  return parsed.success ? parsed.data : RunbookTargetSelector.parse({});
}

export async function resolveTargets(
  selector: RunbookTargetSelector,
  opts: { maxTargets?: number } = {},
): Promise<ResolvedTargets> {
  if (isEmptyRunbookSelector(selector)) throw emptySelectorError();
  const maxTargets = opts.maxTargets ?? env.RUNBOOK_MAX_TARGETS;

  const dims: Prisma.ServerWhereInput[] = [];
  if (selector.tagIds.length) dims.push({ tags: { some: { tagId: { in: selector.tagIds } } } });
  if (selector.environments.length) dims.push({ environment: { in: selector.environments } });
  if (selector.locationIds.length) dims.push({ locationId: { in: selector.locationIds } });

  const anyOf: Prisma.ServerWhereInput[] = [];
  if (selector.serverIds.length) anyOf.push({ id: { in: selector.serverIds } });
  if (dims.length) anyOf.push({ AND: dims });

  const where: Prisma.ServerWhereInput = {
    deletedAt: null,
    // Never empty: isEmptyRunbookSelector() above guarantees at least one branch.
    OR: anyOf,
    ...(selector.excludeServerIds.length ? { id: { notIn: selector.excludeServerIds } } : {}),
    ...(selector.onlyUp ? { lastStatus: "up" } : {}),
  };

  const rows = await prisma.server.findMany({
    where,
    select: { id: true, hostname: true, ip: true, environment: true, lastStatus: true, passwordEnc: true },
    orderBy: { id: "asc" },
    take: maxTargets + 1,
  });

  return {
    servers: rows.slice(0, maxTargets),
    exceeded: rows.length > maxTargets,
    maxTargets,
  };
}

/**
 * Apply a caller-supplied override. It may only NARROW the resolved set: every
 * requested id must already be a target. Otherwise an executor could point an
 * approved runbook at servers its author never selected.
 */
export function narrowTargets<T extends { id: number }>(resolved: T[], serverIds: number[] | undefined): T[] {
  if (!serverIds) return resolved;
  const byId = new Map(resolved.map((s) => [s.id, s]));
  const outside = [...new Set(serverIds)].filter((id) => !byId.has(id));
  if (outside.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Target override may only narrow the runbook's targets; not in the target set: ${outside.slice(0, 20).join(", ")}`,
      400,
    );
  }
  const wanted = new Set(serverIds);
  return resolved.filter((s) => wanted.has(s.id));
}

// ─── Preview warnings ────────────────────────────────────────────────────────

let keyCache: { at: number; present: boolean } | null = null;
const KEY_CACHE_MS = 60_000;

/**
 * Whether any SSH private key connectToServer() would try is present. Mirrors its
 * candidate list closely enough for a preview warning; the connection attempt
 * itself stays the source of truth.
 */
export function sshKeyAvailable(): boolean {
  const now = Date.now();
  if (keyCache && now - keyCache.at < KEY_CACHE_MS) return keyCache.present;
  const candidates = [
    env.SSH_PRIVATE_KEY_PATH,
    "/data/id_ed25519",
    "/data/id_rsa",
    "/root/.ssh/id_ed25519",
    "/root/.ssh/id_rsa",
    path.join(os.homedir(), ".ssh", "id_ed25519"),
    path.join(os.homedir(), ".ssh", "id_rsa"),
  ].filter(Boolean) as string[];
  let present = candidates.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!present) {
    try {
      present = fs.readdirSync("/data/ssh_keys").some((f) => f.endsWith(".pem") || f.endsWith(".key"));
    } catch {
      /* no custom key directory */
    }
  }
  keyCache = { at: now, present };
  return present;
}

/** Test-only: forget the cached key probe. */
export function resetSshKeyCache(): void {
  keyCache = null;
}

export function targetWarnings(
  s: { lastStatus: string; passwordEnc: string | null },
  ctx: { vaultUnlocked: boolean; keyAvailable: boolean },
): RunbookTargetWarning[] {
  const warnings: RunbookTargetWarning[] = [];
  if (s.lastStatus === "down") warnings.push("down");
  // Runs execute in the background with no request session, so only the SYSTEM
  // vault session counts: an operator who unlocked just their own session still
  // gets VAULT_LOCKED on these hosts.
  if (s.passwordEnc?.startsWith("v2.") && !ctx.vaultUnlocked) warnings.push("vault_required");
  if (!s.passwordEnc && !ctx.keyAvailable) warnings.push("no_credentials");
  return warnings;
}

export function previewItems(servers: ResolvedTargets["servers"]): RunbookTargetPreviewItem[] {
  const ctx = { vaultUnlocked: isSystemVaultUnlocked(), keyAvailable: sshKeyAvailable() };
  return servers.map((s) => ({
    serverId: s.id,
    hostname: s.hostname,
    ip: s.ip,
    environment: s.environment,
    lastStatus: s.lastStatus,
    warnings: targetWarnings(s, ctx),
  }));
}

/**
 * True when not one target can possibly run: each needs the vault (its password
 * is v2-encrypted and the system session is locked) AND cannot do without the
 * password — there is no SSH key to connect with, or the run needs sudo.
 */
export function everyTargetNeedsLockedVault(
  servers: ResolvedTargets["servers"],
  opts: { asRoot: boolean; vaultUnlocked?: boolean; keyAvailable?: boolean },
): boolean {
  if (servers.length === 0) return false;
  const vaultUnlocked = opts.vaultUnlocked ?? isSystemVaultUnlocked();
  if (vaultUnlocked) return false;
  const keyAvailable = opts.keyAvailable ?? sshKeyAvailable();
  return servers.every((s) => s.passwordEnc?.startsWith("v2.") && (opts.asRoot || !keyAvailable));
}
