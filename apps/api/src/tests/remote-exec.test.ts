import { describe, it, expect, vi, afterEach } from "vitest";
import { Duplex, PassThrough } from "node:stream";
import type { Client } from "ssh2";
import {
  execRemoteScript,
  execAsRoot,
  execPreferRoot,
  classifySudoFailure,
  buildKillCommand,
  remoteFailureToHttp,
  UPLOAD_COMMAND,
  LOCAL_TIMEOUT_SLACK_MS,
  EXEC_STARTED_MARKER,
  type RemoteScriptResult,
} from "../services/remote-exec.service.js";

/**
 * Tests for the remote-exec primitive against a fake ssh2 client. No real SSH.
 *
 * The fake channel reproduces the one ssh2 behaviour that caused the OS-user
 * hang (ssh2 1.17 lib/utils.js onChannelClose): 'close' is emitted only after
 * stdout has emitted 'end', and an unread stdout never ends.
 */

const REMOTE_FILE = "/tmp/.rackmap-x.AbCdEf1234";
const PASSWORD = "Pw-for-sudo-192.0.2.10";

class FakeChannel extends Duplex {
  readonly stderr = new PassThrough();
  readonly stdinChunks: Buffer[] = [];
  stdinEnded = false;
  closed = false;
  closeCalled = false;
  private finished = false;

  constructor(readonly command: string) {
    super({ allowHalfOpen: true, emitClose: false });
  }

  override _read(): void {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.stdinChunks.push(Buffer.from(chunk));
    cb();
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.stdinEnded = true;
    this.emit("stdin-end");
    cb();
  }

  get stdin(): string {
    return Buffer.concat(this.stdinChunks).toString("utf8");
  }

  /** Run `fn` once our side has ended stdin (i.e. the upload/password is complete). */
  afterStdin(fn: () => void): void {
    if (this.stdinEnded) queueMicrotask(fn);
    else this.once("stdin-end", fn);
  }

  out(data: string | Buffer): void {
    this.push(data);
  }

  err(data: string): void {
    this.stderr.write(data);
  }

  /** What the run wrapper prints once sudo (if any) has let it start. */
  started(): void {
    this.out(EXEC_STARTED_MARKER);
  }

  /** exit-status / exit-signal, then EOF, then 'close' — but only once stdout has ended, as in ssh2. */
  finish(code: number | null, signal?: string): void {
    if (this.finished) return;
    this.finished = true;
    if (code === null) this.emit("exit", null, signal);
    else this.emit("exit", code);
    this.push(null);
    this.stderr.end();
    const emitClose = () => {
      this.closed = true;
      if (code === null) this.emit("close", null, signal);
      else this.emit("close", code);
    };
    if (this.readableEnded) emitClose();
    else this.once("end", emitClose);
  }

  close(): void {
    this.closeCalled = true;
    this.finish(null, "SIGTERM");
  }
}

type Handler = (ch: FakeChannel) => void;

interface HostBehaviour {
  /** `id -u` on the host. */
  uid?: string;
  /** Exit status of `sudo -n /bin/sh -c :`, and what it prints. */
  sudoProbeStatus?: number;
  sudoProbeStderr?: string;
  /** `command -v bash`, or "" when bash is missing. */
  bashPath?: string;
  /** What mktemp hands back. */
  uploadPath?: string;
  run?: Handler;
  kill?: Handler;
  /** Make client.exec fail for commands matching this. */
  failExec?: (cmd: string) => boolean;
}

class FakeClient {
  readonly channels: FakeChannel[] = [];

  constructor(private readonly host: HostBehaviour) {}

  exec(command: string, cb: (err: Error | undefined, ch?: FakeChannel) => void): this {
    if (this.host.failExec?.(command)) {
      queueMicrotask(() => cb(new Error("Channel open failure: open failed")));
      return this;
    }
    const ch = new FakeChannel(command);
    this.channels.push(ch);
    queueMicrotask(() => {
      cb(undefined, ch);
      this.handlerFor(command)(ch);
    });
    return this;
  }

  private handlerFor(command: string): Handler {
    const host = this.host;
    if (command === UPLOAD_COMMAND) {
      return (ch) =>
        ch.afterStdin(() => {
          ch.out(`${host.uploadPath ?? REMOTE_FILE}\n`);
          ch.finish(0);
        });
    }
    if (command.includes("pkill")) {
      return (ch) => {
        (host.kill ?? ((k) => k.afterStdin(() => k.finish(0))))(ch);
        // The kill takes the run chain down with it.
        for (const other of this.channels) {
          if (other !== ch && other.command.includes("rc=$?; rm -f")) other.finish(null, "SIGTERM");
        }
      };
    }
    if (command.includes("rc=$?; rm -f")) {
      return (
        host.run ??
        ((ch) =>
          ch.afterStdin(() => {
            ch.started();
            ch.finish(0);
          }))
      );
    }
    if (command.startsWith("rm -f")) return (ch) => ch.afterStdin(() => ch.finish(0));
    // Probe
    return (ch) =>
      ch.afterStdin(() => {
        if (command.includes("command -v bash")) ch.out(`I=${host.bashPath ?? "/usr/bin/bash"}\n`);
        if (command.includes("id -u")) {
          const uid = host.uid ?? "1000";
          ch.out(`U=${uid}\n`);
          if (uid !== "0") {
            if (host.sudoProbeStderr) ch.err(host.sudoProbeStderr);
            ch.out(`S=${host.sudoProbeStatus ?? 0}\n`);
          }
        }
        ch.finish(0);
      });
  }

  find(pred: (cmd: string) => boolean): FakeChannel[] {
    return this.channels.filter((c) => pred(c.command));
  }

  get uploads(): FakeChannel[] {
    return this.find((c) => c === UPLOAD_COMMAND);
  }

  get runs(): FakeChannel[] {
    return this.find((c) => c.includes("rc=$?; rm -f"));
  }

  get kills(): FakeChannel[] {
    return this.find((c) => c.includes("pkill"));
  }
}

const asClient = (fake: FakeClient) => fake as unknown as Client;

afterEach(() => {
  vi.useRealTimers();
});

describe("fake channel fidelity", () => {
  it("never closes while stdout is unread — the ssh2 behaviour behind the OS-user hang", async () => {
    const ch = new FakeChannel("true");
    ch.out("unread output\n");
    ch.finish(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(ch.closed).toBe(false);
    ch.resume();
    await new Promise((r) => setTimeout(r, 20));
    expect(ch.closed).toBe(true);
  });
});

describe("execRemoteScript", () => {
  it("resolves when the run channel exits and closes with no stdout at all (A2 regression)", async () => {
    const fake = new FakeClient({});
    const res = await execRemoteScript(asClient(fake), { script: "true\n" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.errorCode).toBeUndefined();
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]!.closed).toBe(true);
  });

  it("uploads the script over stdin and never puts it (or the password) in a command string", async () => {
    const script = "printf '%s\\n' 'alice:Secret-Pw-42' | chpasswd\necho done\n";
    const fake = new FakeClient({ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" });
    const res = await execAsRoot(asClient(fake), script, PASSWORD);
    expect(res.exitCode).toBe(0);

    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]!.stdin).toBe(script);
    for (const ch of fake.channels) {
      expect(ch.command).not.toContain("Secret-Pw-42");
      expect(ch.command).not.toContain("chpasswd");
      expect(ch.command).not.toContain(PASSWORD);
    }
    // The staged file is what gets executed, and it is removed afterwards.
    expect(fake.runs[0]!.command).toContain(`'${REMOTE_FILE}'; rc=$?; rm -f '${REMOTE_FILE}'; exit $rc`);
  });

  it("NOPASSWD path: uses sudo -n and never writes the password anywhere", async () => {
    const fake = new FakeClient({ sudoProbeStatus: 0 });
    const res = await execAsRoot(asClient(fake), "id -u\n", PASSWORD);
    expect(res.exitCode).toBe(0);
    const run = fake.runs[0]!;
    expect(run.command.startsWith("sudo -n -- /bin/sh -c ")).toBe(true);
    expect(run.command).not.toContain("sudo -k -S");
    for (const ch of fake.channels) {
      expect(ch.stdin).not.toContain(PASSWORD);
    }
    expect(run.stdinEnded).toBe(true);
  });

  it("password path: writes password + newline exactly once, then ends stdin", async () => {
    const fake = new FakeClient({ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" });
    const res = await execAsRoot(asClient(fake), "id -u\n", PASSWORD);
    expect(res.exitCode).toBe(0);
    const run = fake.runs[0]!;
    expect(run.command.startsWith("sudo -k -S -p '' -- /bin/sh -c ")).toBe(true);
    expect(run.stdin).toBe(`${PASSWORD}\n`);
    expect(run.stdinChunks).toHaveLength(1);
    expect(run.stdinEnded).toBe(true);
    const everyStdin = fake.channels.map((c) => c.stdin).join("");
    expect(everyStdin.split(PASSWORD).length - 1).toBe(1);
  });

  it("skips sudo entirely when the SSH user is already root", async () => {
    const fake = new FakeClient({ uid: "0" });
    await execAsRoot(asClient(fake), "true\n", PASSWORD);
    expect(fake.runs[0]!.command.startsWith("/bin/sh -c ")).toBe(true);
    expect(fake.channels.some((c) => c.stdin.includes(PASSWORD))).toBe(false);
  });

  it("reports SUDO_PASSWORD_REQUIRED without uploading when no password is available", async () => {
    const fake = new FakeClient({ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" });
    const res = await execAsRoot(asClient(fake), "true\n");
    expect(res.errorCode).toBe("SUDO_PASSWORD_REQUIRED");
    expect(fake.uploads).toHaveLength(0);
  });

  it("refuses a password with a line break (it would spill into the script's stdin)", async () => {
    const fake = new FakeClient({ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" });
    const res = await execAsRoot(asClient(fake), "true\n", "first\nsecond");
    expect(res.errorCode).toBe("SUDO_PASSWORD_REQUIRED");
    expect(fake.uploads).toHaveLength(0);
  });

  it("maps a requiretty probe failure without uploading", async () => {
    const fake = new FakeClient({
      sudoProbeStatus: 1,
      sudoProbeStderr: "sudo: sorry, you must have a tty to run sudo\n",
    });
    const res = await execAsRoot(asClient(fake), "true\n", PASSWORD);
    expect(res.errorCode).toBe("SUDO_REQUIRETTY");
    expect(fake.uploads).toHaveLength(0);
  });

  it("maps a wrong password on the run to SUDO_AUTH_FAILED", async () => {
    const fake = new FakeClient({
      sudoProbeStatus: 1,
      sudoProbeStderr: "sudo: a password is required\n",
      run: (ch) =>
        ch.afterStdin(() => {
          ch.err("Sorry, try again.\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n");
          ch.finish(1);
        }),
    });
    const res = await execAsRoot(asClient(fake), "true\n", "wrong");
    expect(res.exitCode).toBe(1);
    expect(res.errorCode).toBe("SUDO_AUTH_FAILED");
  });

  it("does not mislabel a script that exits 1 next to a harmless sudo warning", async () => {
    const fake = new FakeClient({
      sudoProbeStatus: 0,
      run: (ch) =>
        ch.afterStdin(() => {
          ch.err("sudo: unable to resolve host host-01.example.com: Name or service not known\n");
          ch.started();
          ch.finish(1);
        }),
    });
    const res = await execAsRoot(asClient(fake), "exit 1\n", PASSWORD);
    expect(res.exitCode).toBe(1);
    expect(res.errorCode).toBeUndefined();
  });

  it("never maps sudo text when the script did not run through sudo", async () => {
    const fake = new FakeClient({
      run: (ch) =>
        ch.afterStdin(() => {
          ch.started();
          ch.err("sudo: a password is required\n");
          ch.finish(1);
        }),
    });
    const res = await execRemoteScript(asClient(fake), { script: "sudo true\n" });
    expect(res.errorCode).toBeUndefined();
  });

  it("never blames RackMap's sudo for the script's own `sudo -n` failing (it started)", async () => {
    const hosts: Array<[HostBehaviour, string | undefined]> = [
      [{ sudoProbeStatus: 0 }, undefined],
      [{ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" }, PASSWORD],
    ];
    for (const [host, password] of hosts) {
      const fake = new FakeClient({
        ...host,
        run: (ch) =>
          ch.afterStdin(() => {
            ch.started();
            ch.err("sudo: a password is required\n");
            ch.finish(1);
          }),
      });
      const res = await execAsRoot(asClient(fake), "sudo -n systemctl restart app\n", password);
      expect(res.exitCode).toBe(1);
      expect(res.errorCode).toBeUndefined();
      expect(res.errorMessage).toBeUndefined();
      expect(res.stdout).toBe("");
      expect(res.stderr).toBe("sudo: a password is required\n");
    }
  });

  it("the run wrapper prints the start marker before anything else", async () => {
    const fake = new FakeClient({ sudoProbeStatus: 0 });
    await execAsRoot(asClient(fake), "true\n", PASSWORD);
    expect(fake.runs[0]!.command).toContain(`printf %s ${EXEC_STARTED_MARKER}; if command -v timeout`);
  });

  it("strips the start marker even when it is split across chunks, and never streams it", async () => {
    const fake = new FakeClient({
      run: (ch) =>
        ch.afterStdin(() => {
          ch.out(EXEC_STARTED_MARKER.slice(0, 9));
          setTimeout(() => {
            ch.out(`${EXEC_STARTED_MARKER.slice(9)}hello\n`);
            ch.finish(0);
          }, 5);
        }),
    });
    const seen: string[] = [];
    const res = await execRemoteScript(asClient(fake), { script: "echo hello\n", onStdout: (s) => seen.push(s) });
    expect(res.stdout).toBe("hello\n");
    expect(seen.join("")).toBe("hello\n");
  });

  it("keeps output that only resembles the start marker", async () => {
    const partial = EXEC_STARTED_MARKER.slice(0, 7);
    const fake = new FakeClient({
      run: (ch) =>
        ch.afterStdin(() => {
          ch.out(partial);
          ch.finish(0);
        }),
    });
    const res = await execRemoteScript(asClient(fake), { script: "x\n" });
    expect(res.stdout).toBe(partial);
  });

  it("caps each stream, flags truncation and replaces NUL", async () => {
    const fake = new FakeClient({
      run: (ch) =>
        ch.afterStdin(() => {
          ch.started();
          ch.out(Buffer.from("abc\u0000defghij", "utf8"));
          ch.err("0123456789");
          ch.finish(0);
        }),
    });
    const seen: string[] = [];
    const res = await execRemoteScript(asClient(fake), {
      script: "x\n",
      maxOutputBytes: 5,
      onStdout: (s) => seen.push(s),
    });
    expect(res.stdout).toBe("abc�d");
    expect(res.stdout).not.toContain("\u0000");
    expect(res.stdoutTruncated).toBe(true);
    expect(res.stderr).toBe("01234");
    expect(res.stderrTruncated).toBe(true);
    expect(seen.join("")).toBe(res.stdout);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const e = Buffer.from("é", "utf8");
    const fake = new FakeClient({
      run: (ch) =>
        ch.afterStdin(() => {
          ch.started();
          ch.out(e.subarray(0, 1));
          setTimeout(() => {
            ch.out(e.subarray(1));
            ch.finish(0);
          }, 5);
        }),
    });
    const res = await execRemoteScript(asClient(fake), { script: "x\n" });
    expect(res.stdout).toBe("é");
    expect(res.stdoutTruncated).toBe(false);
  });

  it("treats exit 124 / 137 at the deadline as the remote `timeout` firing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (const code of [124, 137]) {
      const fake = new FakeClient({
        run: (ch) =>
          ch.afterStdin(() => {
            ch.started();
            setTimeout(() => ch.finish(code), 5_000);
          }),
      });
      const pending = execRemoteScript(asClient(fake), { script: "sleep 999\n", timeoutSec: 5 });
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await pending;
      expect(res.timedOut).toBe(true);
      expect(res.errorCode).toBe("TIMEOUT");
      expect(fake.kills).toHaveLength(0);
    }
  });

  it("reports an early exit 124 as the script's own status, not a timeout", async () => {
    const fake = new FakeClient({
      run: (ch) =>
        ch.afterStdin(() => {
          ch.started();
          ch.finish(124);
        }),
    });
    const res = await execRemoteScript(asClient(fake), { script: "exit 124\n", timeoutSec: 60 });
    expect(res.exitCode).toBe(124);
    expect(res.timedOut).toBe(false);
    expect(res.errorCode).toBeUndefined();
  });

  it("reports an early 137 as a SIGKILL (e.g. the OOM killer), not a timeout", async () => {
    const fake = new FakeClient({
      run: (ch) =>
        ch.afterStdin(() => {
          ch.started();
          ch.finish(137);
        }),
    });
    const res = await execRemoteScript(asClient(fake), { script: "big-job\n", timeoutSec: 60 });
    expect(res.exitCode).toBe(137);
    expect(res.timedOut).toBe(false);
    expect(res.errorCode).toBeUndefined();
    expect(res.errorMessage).toMatch(/SIGKILL.*out of memory/);
  });

  it("wraps the run in `timeout -k 10 <T>` and passes T, the interpreter and the file as arguments", async () => {
    const fake = new FakeClient({});
    await execRemoteScript(asClient(fake), { script: "x\n", timeoutSec: 42 });
    const cmd = fake.runs[0]!.command;
    expect(cmd).toContain("exec timeout -k 10 \"$1\" \"$2\" \"$3\"");
    expect(cmd).toContain(` rackmap '42' '/bin/sh' '${REMOTE_FILE}';`);
  });

  it("a local timeout opens a pkill channel that targets the staged file", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeClient({
      sudoProbeStatus: 0,
      run: () => {
        /* hangs: never exits */
      },
    });
    const pending = execAsRoot(asClient(fake), "sleep 999\n", PASSWORD, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync((1 + 10) * 1000 + LOCAL_TIMEOUT_SLACK_MS + 1);
    const res = await pending;
    expect(res.timedOut).toBe(true);
    expect(res.errorCode).toBe("TIMEOUT");
    expect(fake.kills).toHaveLength(1);
    const kill = fake.kills[0]!;
    // Same sudo mode as the run (root processes need root to signal them).
    expect(kill.command.startsWith("sudo -n -- /bin/sh -c ")).toBe(true);
    expect(kill.command).toContain("'[/]tmp/[.]rackmap-x[.]AbCdEf1234'");
    expect(kill.stdin).not.toContain(PASSWORD);
  });

  it("an AbortSignal cancels the run through the same pkill path", async () => {
    const controller = new AbortController();
    const fake = new FakeClient({
      sudoProbeStatus: 1,
      sudoProbeStderr: "sudo: a password is required\n",
      run: () => controller.abort(),
    });
    const res = await execAsRoot(asClient(fake), "sleep 999\n", PASSWORD, { signal: controller.signal });
    expect(res.cancelled).toBe(true);
    expect(res.errorCode).toBe("CANCELLED");
    expect(fake.kills).toHaveLength(1);
    expect(fake.kills[0]!.command.startsWith("sudo -k -S -p '' -- ")).toBe(true);
    expect(fake.kills[0]!.stdin).toBe(`${PASSWORD}\n`);
  });

  it("does nothing on the host when the signal is already aborted", async () => {
    const fake = new FakeClient({});
    const controller = new AbortController();
    controller.abort();
    const res = await execRemoteScript(asClient(fake), { script: "x\n", signal: controller.signal });
    expect(res.errorCode).toBe("CANCELLED");
    expect(fake.channels).toHaveLength(0);
  });

  it("refuses an unexpected mktemp path instead of interpolating it", async () => {
    const fake = new FakeClient({ uploadPath: "/tmp/x; rm -rf /" });
    const res = await execRemoteScript(asClient(fake), { script: "x\n" });
    expect(res.errorCode).toBe("UPLOAD_FAILED");
    expect(fake.runs).toHaveLength(0);
  });

  it("reports UPLOAD_FAILED when a channel cannot be opened", async () => {
    const fake = new FakeClient({ failExec: () => true });
    const res = await execRemoteScript(asClient(fake), { script: "x\n" });
    expect(res.errorCode).toBe("UPLOAD_FAILED");
    expect(res.exitCode).toBeNull();
  });

  it("resolves bash on the host, and reports NO_INTERPRETER when it is missing", async () => {
    const withBash = new FakeClient({ bashPath: "/usr/bin/bash" });
    await execRemoteScript(asClient(withBash), { script: "x\n", interpreter: "bash" });
    expect(withBash.runs[0]!.command).toContain(` '/usr/bin/bash' '${REMOTE_FILE}';`);

    const noBash = new FakeClient({ bashPath: "" });
    const res = await execRemoteScript(asClient(noBash), { script: "x\n", interpreter: "bash" });
    expect(res.errorCode).toBe("NO_INTERPRETER");
    expect(noBash.uploads).toHaveLength(0);
  });

  it("execPreferRoot falls back to the SSH user when sudo is unusable", async () => {
    const fake = new FakeClient({ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" });
    const res = await execPreferRoot(asClient(fake), "cat /etc/sudoers 2>/dev/null || true\n");
    expect(res.ranAsRoot).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]!.command.startsWith("/bin/sh -c ")).toBe(true);
  });
});

describe("pkill command", () => {
  it("matches the run chain but never its own processes", () => {
    const kill = buildKillCommand("nopasswd", REMOTE_FILE);
    expect(kill).not.toContain(REMOTE_FILE);
    // The pattern is an ERE; for this character set JS regex semantics are identical.
    const pattern = new RegExp("[/]tmp/[.]rackmap-x[.]AbCdEf1234");
    expect(pattern.test(`/bin/sh -c '...' rackmap '300' '/bin/sh' '${REMOTE_FILE}'`)).toBe(true);
    expect(pattern.test(kill)).toBe(false);
  });
});

describe("classifySudoFailure", () => {
  it.each([
    ["sudo: a password is required\n", "SUDO_PASSWORD_REQUIRED"],
    ["Sorry, try again.\nsudo: 3 incorrect password attempts\n", "SUDO_AUTH_FAILED"],
    ["sudo: sorry, you must have a tty to run sudo\n", "SUDO_REQUIRETTY"],
    ["alice is not in the sudoers file.  This incident will be reported.\n", "SUDO_NOT_ALLOWED"],
    ["Sorry, user alice is not allowed to execute '/bin/sh -c :' as root on host-01.\n", "SUDO_NOT_ALLOWED"],
  ])("%j → %s", (stderr, code) => {
    expect(classifySudoFailure(stderr)).toBe(code);
  });

  it("ignores unrelated sudo warnings", () => {
    expect(classifySudoFailure("sudo: unable to resolve host host-01: Name or service not known\n")).toBeUndefined();
  });
});

describe("remoteFailureToHttp", () => {
  const result = (extra: Partial<RemoteScriptResult>): RemoteScriptResult => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    ...extra,
  });

  it("maps upload, sudo and timeout failures", () => {
    expect(remoteFailureToHttp(result({ errorCode: "UPLOAD_FAILED", errorMessage: "no channel" }))).toEqual({
      status: 503,
      code: "UNREACHABLE",
      message: "no channel",
    });
    expect(remoteFailureToHttp(result({ errorCode: "TIMEOUT", timedOut: true, errorMessage: "slow" }))).toMatchObject({
      status: 504,
      code: "TIMEOUT",
    });
    expect(remoteFailureToHttp(result({ errorCode: "SUDO_REQUIRETTY", errorMessage: "tty" }))).toMatchObject({
      status: 409,
      code: "SUDO_ERROR",
    });
  });

  it("reports a password-hungry sudo as VAULT_LOCKED only when the vault is what withheld the password", () => {
    for (const errorCode of ["SUDO_PASSWORD_REQUIRED", "SUDO_AUTH_FAILED"] as const) {
      const res = result({ errorCode, errorMessage: "sudo wants a password" });
      expect(remoteFailureToHttp(res, { passwordUnavailable: "vault_locked" })).toMatchObject({
        status: 409,
        code: "VAULT_LOCKED",
      });
      expect(remoteFailureToHttp(res)).toMatchObject({ status: 409, code: "SUDO_ERROR" });
    }
    expect(
      remoteFailureToHttp(result({ errorCode: "SUDO_NOT_ALLOWED", errorMessage: "no" }), { passwordUnavailable: "vault_locked" }),
    ).toMatchObject({ code: "SUDO_ERROR" });
    expect(
      remoteFailureToHttp(result({ errorCode: "SUDO_PASSWORD_REQUIRED", errorMessage: "pw" }), {
        passwordUnavailable: "decrypt_failed",
      })?.message,
    ).toContain("could not be decrypted");
  });

  it("leaves results where the script itself ran (or was cancelled) to the caller", () => {
    expect(remoteFailureToHttp(result({ exitCode: 0 }))).toBeUndefined();
    expect(remoteFailureToHttp(result({ exitCode: 1, stderr: "sudo: a password is required\n" }))).toBeUndefined();
    expect(remoteFailureToHttp(result({ exitCode: 137, errorMessage: "killed" }))).toBeUndefined();
    expect(remoteFailureToHttp(result({ errorCode: "CANCELLED", cancelled: true }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OS-user writes go through the primitive (A2 + C)
// ---------------------------------------------------------------------------

const sshState = vi.hoisted(() => ({
  client: null as unknown,
  password: undefined as string | undefined,
  passwordUnavailable: undefined as "vault_locked" | "decrypt_failed" | undefined,
  connects: 0,
}));

vi.mock("../services/ssh.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/ssh.service.js")>();
  return {
    ...actual,
    connectToServer: vi.fn(async () => {
      sshState.connects++;
      return {
        client: sshState.client,
        target: { id: 1, hostname: "host-01.example.com", ip: "192.0.2.10", username: "ops", sshPort: 22 },
        password: sshState.password,
        ...(sshState.passwordUnavailable ? { passwordUnavailable: sshState.passwordUnavailable } : {}),
      };
    }),
  };
});

describe("OS-user service over the primitive", () => {
  const withHost = (host: HostBehaviour, password?: string) => {
    const fake = new FakeClient(host);
    Object.assign(fake, { end: vi.fn() });
    sshState.client = fake;
    sshState.password = password;
    sshState.passwordUnavailable = undefined;
    sshState.connects = 0;
    return fake;
  };
  /** Commands in the root script, without the guard/PATH lines. */
  const hasInnerSudo = (script: string) => /(^|[\s;&|(])sudo\s/m.test(script);

  it("createOsUser resolves (no hang) and keeps chpasswd input out of argv", async () => {
    const { createOsUser } = await import("../services/os-user.service.js");
    const fake = withHost({ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" }, PASSWORD);
    const res = await createOsUser(
      1,
      { username: "alice", password: "Acct-Pw-7", groups: ["developers"], sudoType: "custom", customCommands: ["/usr/bin/systemctl restart nginx"] },
      {},
      undefined,
      { allowPrivileged: true },
    );
    expect(res.ok).toBe(true);

    const script = fake.uploads[0]!.stdin;
    expect(script).toContain("useradd -m -G 'developers' 'alice'");
    expect(script).toContain("printf '%s\\n' 'alice:Acct-Pw-7' | chpasswd");
    expect(script).toContain("visudo -cf");
    expect(hasInnerSudo(script)).toBe(false);
    for (const ch of fake.channels) {
      expect(ch.command).not.toContain("Acct-Pw-7");
      expect(ch.command).not.toContain(PASSWORD);
    }
    expect(fake.runs[0]!.stdin).toBe(`${PASSWORD}\n`);
    expect((fake as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled();
  });

  it("updateOsUser never writes the new password into the audit log", async () => {
    const { updateOsUser } = await import("../services/os-user.service.js");
    const { prisma } = await import("../db.js");
    withHost({ sudoProbeStatus: 0 });
    await updateOsUser(1, "bob", { password: "Audit-Leak-Check-9", shell: "/bin/bash" }, {}, undefined, {
      allowPrivileged: true,
    });
    const row = await prisma.auditLog.findFirst({
      where: { action: "server.os_user_update" },
      orderBy: { id: "desc" },
    });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain("Audit-Leak-Check-9");
  });

  it("without server:sudo, update carries a host-side privileged-target guard and maps its refusal", async () => {
    const { updateOsUser, PrivilegedTargetError } = await import("../services/os-user.service.js");
    const fake = withHost({
      sudoProbeStatus: 0,
      run: (ch) =>
        ch.afterStdin(() => {
          ch.started();
          ch.err("RACKMAP_PRIVILEGED_TARGET\n");
          ch.finish(77);
        }),
    });
    await expect(updateOsUser(1, "admin-user", { password: "New-Pw-1" }, {}, undefined, {})).rejects.toBeInstanceOf(
      PrivilegedTargetError,
    );
    const script = fake.uploads[0]!.stdin;
    expect(script).toContain("RACKMAP_PRIVILEGED_TARGET");
    expect(script.indexOf("RACKMAP_PRIVILEGED_TARGET")).toBeLessThan(script.indexOf("chpasswd"));
  });

  it("rejects a password with a line break before connecting (chpasswd line injection)", async () => {
    const { updateOsUser } = await import("../services/os-user.service.js");
    withHost({});
    await expect(
      updateOsUser(1, "bob", { password: "x\nroot:pwned" }, {}, undefined, { allowPrivileged: true }),
    ).rejects.toThrow(/line breaks/);
    expect(sshState.connects).toBe(0);
  });

  it("deleteOsUser builds a plain root script from the parsed booleans", async () => {
    const { deleteOsUser } = await import("../services/os-user.service.js");
    const fake = withHost({ sudoProbeStatus: 0 });
    await deleteOsUser(1, "carol", { removeHome: false, force: false }, {}, undefined, { allowPrivileged: true });
    const script = fake.uploads[0]!.stdin;
    // removeHome=false, force=false → neither -r nor -f on userdel.
    expect(script).toMatch(/^userdel {2}'carol' \|\| exit \$\?$/m);
    expect(script).toContain("rm -f '/etc/sudoers.d/rackmap_carol'");
    expect(hasInnerSudo(script)).toBe(false);
  });

  it("createOsUser without server:sudo checks requested groups against the host's sudoers", async () => {
    const { createOsUser } = await import("../services/os-user.service.js");
    const fake = withHost({ sudoProbeStatus: 0 });
    await createOsUser(1, { username: "erin", groups: ["deploy", "users"] });
    const script = fake.uploads[0]!.stdin;
    // A custom group with its own `%deploy ALL=…` rule is root-equivalent even
    // though it is not on the static list; the host-side loop catches it.
    expect(script).toContain("for g in 'deploy' 'users'; do");
    expect(script).toContain('awk -v g="%$g"');
    expect(script.indexOf("for g in")).toBeLessThan(script.indexOf("useradd"));
  });

  it("createOsUser with server:sudo skips the group check", async () => {
    const { createOsUser } = await import("../services/os-user.service.js");
    const fake = withHost({ sudoProbeStatus: 0 });
    await createOsUser(1, { username: "erin", groups: ["deploy"] }, {}, undefined, { allowPrivileged: true });
    expect(fake.uploads[0]!.stdin).not.toContain("for g in");
  });

  it("deleteOsUser without server:sudo refuses root-equivalent accounts on the host", async () => {
    const { deleteOsUser } = await import("../services/os-user.service.js");
    const fake = withHost({ sudoProbeStatus: 0 });
    await deleteOsUser(1, "carol", { removeHome: true, force: false });
    const script = fake.uploads[0]!.stdin;
    expect(script).toContain("RACKMAP_PRIVILEGED_TARGET");
    // The guard runs before userdel.
    expect(script.indexOf("RACKMAP_PRIVILEGED_TARGET")).toBeLessThan(script.indexOf("userdel"));
  });

  it("a locked vault with a password-only sudo surfaces as 409 VAULT_LOCKED", async () => {
    const { createOsUser, osUserErrorToHttp } = await import("../services/os-user.service.js");
    withHost({ sudoProbeStatus: 1, sudoProbeStderr: "sudo: a password is required\n" });
    sshState.passwordUnavailable = "vault_locked";
    const err = await createOsUser(1, { username: "dave" }, {}, undefined, { allowPrivileged: true }).catch((e) => e);
    expect(osUserErrorToHttp(err, "OS_USER_CREATE_ERROR")).toMatchObject({ status: 409, code: "VAULT_LOCKED" });
  });

  it("a staging failure is 503 UNREACHABLE, not the generic 400", async () => {
    const { createOsUser, osUserErrorToHttp } = await import("../services/os-user.service.js");
    withHost({ sudoProbeStatus: 0, uploadPath: "not-a-mktemp-path" });
    const err = await createOsUser(1, { username: "erin" }, {}, undefined, { allowPrivileged: true }).catch((e) => e);
    expect(osUserErrorToHttp(err, "OS_USER_CREATE_ERROR")).toMatchObject({ status: 503, code: "UNREACHABLE" });
  });
});
