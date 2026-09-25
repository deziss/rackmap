import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import {
  HEARTBEAT_MAX_CRON_LINE,
  HeartbeatWrapError,
  splitCronCommandRaw,
  unwrapHeartbeatCommand,
  wrapCommandForHeartbeat,
} from "@inv/shared";

/**
 * The wrapper rewrites a line in someone's production crontab. It has to be
 * reversible byte-for-byte, keep the job's semantics (stdin, comments, `&`,
 * exit code), and refuse anything it cannot represent safely.
 */

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"; // 43 base64url chars (example)
const BASE = "https://rackmap.example.com";

function roundTrip(command: string, measureDuration = false) {
  const wrapped = wrapCommandForHeartbeat({ command, pingBase: BASE, token: TOKEN, measureDuration });
  const back = unwrapHeartbeatCommand(wrapped);
  expect(back).not.toBeNull();
  expect(back!.command).toBe(command);
  expect(back!.token).toBe(TOKEN);
  expect(back!.pingBase).toBe(BASE);
  expect(back!.measureDuration).toBe(measureDuration);
  return wrapped;
}

describe("wrap / unwrap", () => {
  it("round-trips plain commands, with and without duration tracking", () => {
    const w = roundTrip("/usr/local/bin/backup.sh --full");
    expect(w).toBe(
      `"\${SHELL:-/bin/sh}" -c '/usr/local/bin/backup.sh --full'; rc=$?; u="${BASE}/api/v1/ping/${TOKEN}/$rc"; ` +
        `(curl -fsS -m 10 --retry 3 -o /dev/null "$u" || wget -q -T 10 -O /dev/null "$u") >/dev/null 2>&1; exit $rc`,
    );
    const s = roundTrip("/usr/local/bin/backup.sh", true);
    expect(s.startsWith(`u="${BASE}/api/v1/ping/${TOKEN}/start"; (curl`)).toBe(true);
  });

  it("round-trips single quotes", () => {
    roundTrip(`echo 'it'\\''s' "a 'b' c" '' x'y'z`);
  });

  it("keeps the % stdin part outside the quotes", () => {
    const cmd = "mail -s 'nightly report' ops@example.com%Line one%Line two";
    const w = roundTrip(cmd);
    expect(w.endsWith("exit $rc%Line one%Line two")).toBe(true);
    // Only the part before the first unescaped % is quoted.
    expect(w).toContain(`-c 'mail -s '\\''nightly report'\\'' ops@example.com'`);
  });

  it("treats an escaped \\% as part of the command", () => {
    expect(splitCronCommandRaw("date +\\%F%stdin")).toEqual({ cmdPart: "date +\\%F", stdinPart: "%stdin" });
    const w = roundTrip("date +\\%Y-\\%m-\\%d > /tmp/example-date");
    expect(w).not.toMatch(/exit \$rc%/);
  });

  it("neutralises a trailing & and an inline # comment", () => {
    const amp = roundTrip("sleep 30 &");
    expect(amp).toContain(`-c 'sleep 30 &'; rc=$?`);
    const hash = roundTrip("run-report # nightly");
    expect(hash).toContain(`-c 'run-report # nightly'; rc=$?`);
  });

  it("the wrapper itself contains no %", () => {
    expect(wrapCommandForHeartbeat({ command: "true", pingBase: BASE, token: TOKEN, measureDuration: true })).not.toContain("%");
  });

  it("rejects hostile or malformed base URLs", () => {
    for (const base of [
      'https://example.com/"; rm -rf / #',
      "https://example.com/$(id)",
      "https://example.com/`id`",
      "https://user:pass@example.com",
      "https://example.com/?q=1",
      "ftp://example.com",
      "https://example.com/a b",
      "https://example.com\\x",
    ]) {
      expect(() => wrapCommandForHeartbeat({ command: "true", pingBase: base, token: TOKEN })).toThrow(HeartbeatWrapError);
    }
    // A path prefix and a port are fine; trailing slashes are dropped.
    const w = wrapCommandForHeartbeat({ command: "true", pingBase: "http://192.0.2.10:3001/rackmap/", token: TOKEN });
    expect(w).toContain('u="http://192.0.2.10:3001/rackmap/api/v1/ping/');
  });

  it("rejects bad tokens, empty and multi-line commands, and double wrapping", () => {
    expect(() => wrapCommandForHeartbeat({ command: "true", pingBase: BASE, token: "short" })).toThrow(/token/);
    expect(() => wrapCommandForHeartbeat({ command: "%only stdin", pingBase: BASE, token: TOKEN })).toThrow(/no command/);
    expect(() => wrapCommandForHeartbeat({ command: "a\nb", pingBase: BASE, token: TOKEN })).toThrow(/line breaks/);
    const once = wrapCommandForHeartbeat({ command: "true", pingBase: BASE, token: TOKEN });
    expect(() => wrapCommandForHeartbeat({ command: once, pingBase: BASE, token: TOKEN })).toThrow(/already/);
  });

  it("rejects lines cron would truncate", () => {
    const long = `/opt/example/bin/job ${"x".repeat(850)}`;
    expect(() => wrapCommandForHeartbeat({ command: long, pingBase: BASE, token: TOKEN })).toThrow(/characters/);
    const fits = "y".repeat(400);
    const w = wrapCommandForHeartbeat({ command: fits, pingBase: BASE, token: TOKEN });
    expect(() =>
      wrapCommandForHeartbeat({ command: fits, pingBase: BASE, token: TOKEN, linePrefixLength: HEARTBEAT_MAX_CRON_LINE - w.length + 1 }),
    ).toThrow(/characters/);
  });

  it("does not recognise hand-edited or foreign lines", () => {
    expect(unwrapHeartbeatCommand("/usr/local/bin/backup.sh")).toBeNull();
    const w = wrapCommandForHeartbeat({ command: "true", pingBase: BASE, token: TOKEN });
    expect(unwrapHeartbeatCommand(w.replace("--retry 3", "--retry 5"))).toBeNull();
    expect(unwrapHeartbeatCommand(`${w}; echo extra`)).toBeNull();
  });
});

/**
 * Run the generated line the way cron would: split at the first unescaped %, turn
 * the remaining % into newlines for stdin, and hand the command to /bin/sh -c.
 */
function runLikeCron(line: string): Promise<{ code: number | null; stdout: string }> {
  const { cmdPart, stdinPart } = splitCronCommandRaw(line);
  const command = cmdPart.replace(/\\%/g, "%");
  const stdin = stdinPart ? stdinPart.slice(1).replace(/%/g, "\n") + "\n" : "";
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" } });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

describe("the wrapped line on a real shell", () => {
  let server: Server;
  let base = "";
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("preserves the exit code and pings with it", async () => {
    hits.length = 0;
    const cmd = wrapCommandForHeartbeat({ command: "echo hello; exit 3", pingBase: base, token: TOKEN, measureDuration: true });
    const r = await runLikeCron(cmd);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe("hello\n");
    expect(hits).toEqual([`/api/v1/ping/${TOKEN}/start`, `/api/v1/ping/${TOKEN}/3`]);
  });

  it("feeds the % stdin part to the job, quotes and comments intact", async () => {
    hits.length = 0;
    const cmd = wrapCommandForHeartbeat({ command: "tr a-z A-Z; echo 'it'\\''s' # done%first%second", pingBase: base, token: TOKEN });
    const r = await runLikeCron(cmd);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("FIRST\nSECOND\nit's\n");
    expect(hits).toEqual([`/api/v1/ping/${TOKEN}/0`]);
  });

  it("a backgrounded job reports success without breaking the line", async () => {
    hits.length = 0;
    const cmd = wrapCommandForHeartbeat({ command: "sleep 0 &", pingBase: base, token: TOKEN });
    const r = await runLikeCron(cmd);
    expect(r.code).toBe(0);
    expect(hits).toEqual([`/api/v1/ping/${TOKEN}/0`]);
  });
});
