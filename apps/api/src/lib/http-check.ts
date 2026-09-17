import http from "http";
import https from "https";
import { URL } from "url";
import { resolveTargetHost } from "./target-resolver.js";

export async function httpProbe(targetUrl: string, timeoutMs: number) {
  return new Promise<{ status: "up" | "down"; latencyMs: number | null; errorCode: string | null }>((resolve) => {
    const start = Date.now();
    let isSettled = false;

    const done = (status: "up" | "down", errorCode: string | null) => {
      if (isSettled) return;
      isSettled = true;
      const latencyMs = status === "up" ? Date.now() - start : null;
      resolve({ status, latencyMs, errorCode });
    };

    try {
      const parsedUrl = new URL(targetUrl);
      const originalHost = parsedUrl.hostname;
      const resolvedHost = resolveTargetHost(originalHost);

      const isHttps = parsedUrl.protocol === "https:";
      const client = isHttps ? https : http;
      const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80);

      const req = client.request(
        {
          protocol: parsedUrl.protocol,
          hostname: resolvedHost,
          port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "GET",
          headers: {
            Host: parsedUrl.host,
          },
          timeout: timeoutMs,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            done("up", null);
          } else {
            done("down", `HTTP_${res.statusCode}`);
          }
          res.resume();
        }
      );

      req.on("timeout", () => {
        req.destroy();
        done("down", "ETIMEDOUT");
      });

      req.on("error", (err: NodeJS.ErrnoException) => {
        done("down", err.code ?? "UNKNOWN_ERROR");
      });

      req.end();
    } catch (e) {
      done("down", "INVALID_URL");
    }
  });
}
