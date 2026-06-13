import { cn } from "@/lib/utils";

interface StatusDotProps {
  status: "up" | "down" | "unknown";
  latencyMs?: number | null;
  ip?: string;
  port?: number;
  size?: "sm" | "md";
}

export function StatusDot({ status, latencyMs, ip, port, size = "md" }: StatusDotProps) {
  const colorMap = {
    up:      "bg-emerald-500",
    down:    "bg-red-500",
    unknown: "bg-slate-400",
  };

  const glowMap = {
    up:      "shadow-[0_0_6px_2px_oklch(0.7_0.2_145_/_0.5)]",
    down:    "shadow-[0_0_6px_2px_oklch(0.65_0.22_22_/_0.5)]",
    unknown: "",
  };

  const pulseMap = {
    up:      "animate-pulse",
    down:    "",
    unknown: "",
  };

  const sizeMap = {
    sm: "h-2 w-2",
    md: "h-2.5 w-2.5",
  };

  const label =
    status === "up"
      ? `Up${latencyMs != null ? ` — ${latencyMs}ms` : ""}${ip && port ? ` (${ip}:${port})` : ""}`
      : status === "down"
      ? `Down${ip && port ? ` (${ip}:${port})` : ""}`
      : "Unknown";

  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        "inline-block rounded-full",
        sizeMap[size],
        colorMap[status],
        glowMap[status],
        pulseMap[status],
      )}
    />
  );
}
