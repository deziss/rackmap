import { connectToServer, buildSudoCommand, SshError } from "./ssh.service.js";
import type { LogQueryInput, LogResponse, LogEntry } from "@inv/shared";

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function parseLogLine(raw: string, defaultSource: string): LogEntry {
  const line = raw.trim();
  if (!line) {
    return { timestamp: null, service: null, priority: null, message: "", raw };
  }

  // Check ISO timestamp: 2026-09-17T21:00:15+0530 hostname unit[pid]: message
  const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]+)\s+([^\s]+)\s+([^:]+):\s+(.*)$/);
  if (isoMatch) {
    const [, timestamp, , service, message] = isoMatch;
    let priority = "info";
    const lower = message?.toLowerCase() || "";
    if (lower.includes("err") || lower.includes("fail") || lower.includes("fatal")) priority = "err";
    else if (lower.includes("warn")) priority = "warning";
    return { timestamp: timestamp || null, service: service || null, priority, message: message || "", raw };
  }

  // Check Syslog format: Sep 17 21:00:15 hostname service[pid]: message
  const syslogMatch = line.match(/^([A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2})\s+([^\s]+)\s+([^:]+):\s+(.*)$/);
  if (syslogMatch) {
    const [, timestamp, , service, message] = syslogMatch;
    let priority = "info";
    const lower = message?.toLowerCase() || "";
    if (lower.includes("err") || lower.includes("fail") || lower.includes("fatal")) priority = "err";
    else if (lower.includes("warn")) priority = "warning";
    return { timestamp: timestamp || null, service: service || null, priority, message: message || "", raw };
  }

  // Check dmesg format: [Thu Sep 17 21:00:15 2026] message or [ 1234.567] message
  const dmesgMatch = line.match(/^\[([^\]]+)\]\s+(.*)$/);
  if (dmesgMatch) {
    const [, timestamp, message] = dmesgMatch;
    let priority = "info";
    const lower = message?.toLowerCase() || "";
    if (lower.includes("error") || lower.includes("fail") || lower.includes("corrupt")) priority = "err";
    else if (lower.includes("warn")) priority = "warning";
    return { timestamp: timestamp || null, service: "kernel", priority, message: message || "", raw };
  }

  return {
    timestamp: null,
    service: defaultSource,
    priority: "info",
    message: line,
    raw,
  };
}

export async function queryServerLogs(serverId: number, query: LogQueryInput, overridePassword?: string): Promise<LogResponse> {
  const { client, password } = await connectToServer(serverId, overridePassword);
  const lines = Math.min(Math.max(query.lines || 200, 1), 2000);

  let command = "";
  if (query.source === "journalctl") {
    const args: string[] = ["journalctl", "--no-pager", `-n ${lines}`, "--output=short-iso"];
    if (query.unit) {
      const sanitizedUnit = query.unit.trim().replace(/[^a-zA-Z0-9_.-@]/g, "");
      if (sanitizedUnit) args.push(`-u ${escapeShellArg(sanitizedUnit)}`);
    }
    if (query.priority) {
      args.push(`-p ${escapeShellArg(query.priority)}`);
    }
    if (query.since) {
      args.push(`--since ${escapeShellArg(query.since)}`);
    }
    if (query.filterText) {
      args.push(`-g ${escapeShellArg(query.filterText)}`);
    }
    const journalCmd = args.join(" ");
    command = `${buildSudoCommand(journalCmd, password)} 2>/dev/null || ${journalCmd}`;
  } else if (query.source === "auth") {
    const filter = query.filterText ? ` | grep -i ${escapeShellArg(query.filterText)}` : "";
    const authCmd = `tail -n ${lines} /var/log/auth.log 2>/dev/null ${filter}`;
    const fallbackCmd = `journalctl -u ssh -u sudo --no-pager -n ${lines} --output=short-iso ${filter}`;
    command = `${buildSudoCommand(authCmd, password)} || ${buildSudoCommand(fallbackCmd, password)} || ${authCmd}`;
  } else if (query.source === "syslog") {
    const filter = query.filterText ? ` | grep -i ${escapeShellArg(query.filterText)}` : "";
    const sysCmd = `tail -n ${lines} /var/log/syslog 2>/dev/null ${filter}`;
    const sysFallback = `journalctl --no-pager -n ${lines} --output=short-iso ${filter}`;
    command = `${buildSudoCommand(sysCmd, password)} || ${buildSudoCommand(sysFallback, password)} || ${sysCmd}`;
  } else if (query.source === "dmesg") {
    const filter = query.filterText ? ` | grep -i ${escapeShellArg(query.filterText)}` : "";
    const dmesgCmd = `dmesg -T 2>/dev/null | tail -n ${lines} ${filter} || dmesg | tail -n ${lines} ${filter}`;
    command = `${buildSudoCommand(dmesgCmd, password)} 2>/dev/null || ${dmesgCmd}`;
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    client.exec(command, (err, stream) => {
      if (err) {
        client.end();
        return reject(new SshError("unreachable", `Failed to execute log query: ${err.message}`));
      }

      stream
        .on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        })
        .stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

      stream.on("close", () => {
        client.end();
        const rawLines = stdout.split("\n").filter((l) => l.trim().length > 0);
        const entries = rawLines.map((l) => parseLogLine(l, query.source));

        resolve({
          entries,
          total: entries.length,
          source: query.source,
        });
      });
    });
  });
}
