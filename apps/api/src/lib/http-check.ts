import http from "http";
import https from "https";
import { URL } from "url";

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
      const client = parsedUrl.protocol === "https:" ? https : http;

      const req = client.request(
        parsedUrl,
        { method: "GET", timeout: timeoutMs },
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
