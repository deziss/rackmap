import * as fs from "node:fs";
import * as net from "node:net";

let cachedHostGateway: string | null = null;

/**
 * Returns true if the host is a local loopback address:
 * - "localhost" or "localhost.localdomain"
 * - "0.0.0.0"
 * - "::1" or "[::1]"
 * - Any IPv4 address in the 127.0.0.0/8 subnet (e.g. 127.0.0.1, 127.0.1.1)
 */
export function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]" || h === "localhost.localdomain") {
    return true;
  }
  if (/^127(?:\.\d+){1,3}$/.test(h)) {
    return true;
  }
  return false;
}

/**
 * Detects whether the application is running inside a Docker or containerized environment.
 */
export function isRunningInDocker(): boolean {
  return (
    process.env.IN_DOCKER === "true" ||
    fs.existsSync("/.dockerenv") ||
    fs.existsSync("/run/.containerenv") ||
    Boolean(process.env.DOCKER_HOST_OVERRIDE)
  );
}

/**
 * Detects the host machine gateway IP when running inside Docker.
 * 1. Checks explicit DOCKER_HOST_OVERRIDE or HOST_GATEWAY env variables
 * 2. Checks /etc/hosts for host.docker.internal mapped entry
 * 3. Parses Linux /proc/net/route for the default route gateway (e.g. 172.17.0.1)
 * 4. Falls back to "host.docker.internal"
 */
export function getDockerHostGatewaySync(): string {
  if (cachedHostGateway) return cachedHostGateway;

  if (process.env.DOCKER_HOST_OVERRIDE) {
    const gw = process.env.DOCKER_HOST_OVERRIDE;
    cachedHostGateway = gw;
    return gw;
  }
  if (process.env.HOST_GATEWAY) {
    const gw = process.env.HOST_GATEWAY;
    cachedHostGateway = gw;
    return gw;
  }

  // 1. Check if /etc/hosts has host.docker.internal
  if (fs.existsSync("/etc/hosts")) {
    try {
      const hosts = fs.readFileSync("/etc/hosts", "utf8");
      for (const line of hosts.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && parts[0] && parts.includes("host.docker.internal")) {
          const gw = parts[0];
          cachedHostGateway = gw;
          return gw;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // 2. Check /proc/net/route for default route gateway on Linux
  if (fs.existsSync("/proc/net/route")) {
    try {
      const routes = fs.readFileSync("/proc/net/route", "utf8");
      for (const line of routes.split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields[1] === "00000000" && fields[2] && fields[2].length === 8) {
          const hex = fields[2];
          // In Linux /proc/net/route, hex is 32-bit little-endian IPv4
          const b1 = parseInt(hex.substring(0, 2), 16);
          const b2 = parseInt(hex.substring(2, 4), 16);
          const b3 = parseInt(hex.substring(4, 6), 16);
          const b4 = parseInt(hex.substring(6, 8), 16);
          const gw = `${b4}.${b3}.${b2}.${b1}`;
          if (net.isIPv4(gw) && gw !== "0.0.0.0") {
            cachedHostGateway = gw;
            return gw;
          }
        }
      }
    } catch {
      // Ignore route parse errors
    }
  }

  const fallback = "host.docker.internal";
  cachedHostGateway = fallback;
  return fallback;
}

/**
 * Resolves a network target host.
 * If running inside a Docker container and the target is a local loopback address
 * (localhost, 127.0.0.1, 0.0.0.0, etc.), it routes the target to the Docker host
 * machine so that host services (SSH, ports, metrics) can be probed and monitored.
 */
export function resolveTargetHost(target: string): string {
  if (!target) return target;
  if (!isRunningInDocker()) return target;

  if (isLoopbackHost(target)) {
    return getDockerHostGatewaySync();
  }

  return target;
}
