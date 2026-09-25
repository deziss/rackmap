import { connectToServer, SshError } from "./ssh.service.js";
import { escapeShellArg } from "./shell-escape.js";
import { execPreferRoot, describeRemoteFailure, type RemoteScriptResult } from "./remote-exec.service.js";
import type { LogQueryInput, LogResponse, LogEntry } from "@inv/shared";

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
      // The hyphen is escaped on purpose: `.-@` inside a character class is the
      // range 0x2E-0x40, which silently allowed `/ : ; < = > ? @` through.
      const sanitizedUnit = query.unit.trim().replace(/[^a-zA-Z0-9_.\-@]/g, "");
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
    command = `${journalCmd} 2>/dev/null`;
  } else if (query.source === "auth") {
    const filter = query.filterText ? ` | grep -i ${escapeShellArg(query.filterText)}` : "";
    const authCmd = `tail -n ${lines} /var/log/auth.log 2>/dev/null ${filter}`;
    const fallbackCmd = `journalctl -u ssh -u sudo --no-pager -n ${lines} --output=short-iso ${filter}`;
    command = `${authCmd} || ${fallbackCmd}`;
  } else if (query.source === "syslog") {
    const filter = query.filterText ? ` | grep -i ${escapeShellArg(query.filterText)}` : "";
    const sysCmd = `tail -n ${lines} /var/log/syslog 2>/dev/null ${filter}`;
    const sysFallback = `journalctl --no-pager -n ${lines} --output=short-iso ${filter}`;
    command = `${sysCmd} || ${sysFallback}`;
  } else if (query.source === "dmesg") {
    const filter = query.filterText ? ` | grep -i ${escapeShellArg(query.filterText)}` : "";
    command = `dmesg -T 2>/dev/null | tail -n ${lines} ${filter} || dmesg | tail -n ${lines} ${filter}`;
  }

  const probeCmd = `SZ=$(du -sh /var/log 2>/dev/null | head -n 1 | awk '{print $1}'); JU=$(journalctl --disk-usage 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9.]+[KMGTPEB]+$/) print $i}' | head -n 1); echo "===METADATA:LOG_SIZE=\${SZ:-N/A}:JOURNAL_SIZE=\${JU:-N/A}===";`;

  // Root when sudo is usable (full journal, auth.log), otherwise the SSH user
  // sees what it can — the old `sudo cmd || cmd` fallback, minus the password
  // that `echo '<pw>' | sudo -S` used to put in the remote command line.
  let result: RemoteScriptResult;
  try {
    result = await execPreferRoot(client, `${probeCmd}\n${command}\n`, password, {
      timeoutMs: 120_000,
      maxOutputBytes: 16 * 1024 * 1024,
    });
  } finally {
    client.end();
  }
  if (result.errorCode === "UPLOAD_FAILED" || result.errorCode === "TIMEOUT") {
    throw new SshError("unreachable", `Failed to execute log query: ${describeRemoteFailure(result)}`);
  }

  let totalLogSize: string | null = null;
  let journalDiskUsage: string | null = null;

  const rawLines = result.stdout.split("\n");
  const cleanLines: string[] = [];

  for (const line of rawLines) {
    const metaMatch = line.match(/^===METADATA:LOG_SIZE=([^:]+):JOURNAL_SIZE=([^=]+)===/);
    if (metaMatch) {
      const sz = metaMatch[1]?.trim();
      const ju = metaMatch[2]?.trim();
      totalLogSize = sz && sz !== "N/A" ? sz : null;
      journalDiskUsage = ju && ju !== "N/A" ? ju : null;
    } else if (line.trim().length > 0) {
      cleanLines.push(line);
    }
  }

  const entries = cleanLines.map((l) => parseLogLine(l, query.source));

  return {
    entries,
    total: entries.length,
    source: query.source,
    totalLogSize,
    journalDiskUsage,
  };
}
