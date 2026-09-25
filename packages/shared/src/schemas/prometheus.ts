import { z } from "zod";
import { SERVER_STATUS } from "../constants.js";

/**
 * Prometheus HTTP service discovery (`http_sd_configs`).
 *
 * GET /api/v1/prometheus/sd returns one target group per non-deleted server so
 * Prometheus can scrape an exporter (node_exporter by default) on every host
 * RackMap knows about, without a second hand-maintained target list.
 *
 * Label values are always strings with no control characters. `rackmap_tags`
 * is the sorted tag list wrapped in commas (`,db,web,`) so a relabel rule can
 * match one tag with `regex: ".*,web,.*"`; it is "" for an untagged server.
 */

export const PROMETHEUS_SD_ADDRESS_MODES = ["ip", "hostname"] as const;
export type PrometheusSdAddressMode = (typeof PROMETHEUS_SD_ADDRESS_MODES)[number];

/** Every label a target group carries, in the order they are emitted. */
export const PROMETHEUS_SD_LABELS = [
  "rackmap_server_id",
  "rackmap_hostname",
  "rackmap_environment",
  "rackmap_location",
  "rackmap_server_type",
  "rackmap_status",
  "rackmap_tags",
] as const;
export type PrometheusSdLabel = (typeof PROMETHEUS_SD_LABELS)[number];

/** Upper bound on repeated `tag` filters, so one request cannot build an unbounded query. */
export const PROMETHEUS_SD_MAX_TAG_FILTERS = 20;

const TagFilter = z.string().trim().min(1).max(60);

/**
 * Query string for GET /api/v1/prometheus/sd.
 *
 * - `port`        exporter port appended to every target (default: PROMETHEUS_SD_DEFAULT_PORT)
 * - `address`     `ip` (default) or `hostname` as the target host
 * - `environment` exact environment, case-insensitive
 * - `location`    location id or name (case-insensitive)
 * - `tag`         tag name, repeatable; a server must carry every listed tag
 * - `status`      only servers whose last probe was up / down / unknown
 * - `excludeDown` `true` drops servers whose last probe was down
 */
export const PrometheusSdQuery = z.object({
  port: z.coerce.number().int().min(1).max(65535).optional(),
  address: z.enum(PROMETHEUS_SD_ADDRESS_MODES).default("ip"),
  environment: z.string().trim().min(1).max(64).optional(),
  location: z.string().trim().min(1).max(255).optional(),
  tag: z
    .union([TagFilter, z.array(TagFilter).max(PROMETHEUS_SD_MAX_TAG_FILTERS)])
    .optional()
    .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  status: z.enum(SERVER_STATUS).optional(),
  excludeDown: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .transform((v) => v === true || v === "true" || v === "1")
    .optional(),
});
export type PrometheusSdQuery = z.infer<typeof PrometheusSdQuery>;

/** One entry of the http_sd_configs response body. */
export const PrometheusSdTargetGroup = z.object({
  targets: z.array(z.string()),
  labels: z.record(z.string(), z.string()),
});
export type PrometheusSdTargetGroup = z.infer<typeof PrometheusSdTargetGroup>;
