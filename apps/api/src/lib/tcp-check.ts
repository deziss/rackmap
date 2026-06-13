import * as net from "node:net";

export interface ProbeResult {
  status: "up" | "down";
  latencyMs: number | null;
  errorCode: string | null;
}

const WHITELISTED_CODES = new Set(["ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND"]);

export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();

    const done = (result: ProbeResult) => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      done({ status: "up", latencyMs: Date.now() - start, errorCode: null });
    });

    socket.on("timeout", () => {
      done({ status: "down", latencyMs: null, errorCode: "ETIMEDOUT" });
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "UNKNOWN";
      done({
        status: "down",
        latencyMs: null,
        errorCode: WHITELISTED_CODES.has(code) ? code : "UNKNOWN",
      });
    });
  });
}
