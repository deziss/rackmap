/** Fixtures for the patch-management tests: host output in the scan/apply marker protocol. */

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const val = (k: string, v: string) => `===${k}===\n${b64(v)}\n`;

export interface ScanFixture {
  root?: string;
  os?: string;
  krun?: string;
  kinst?: string[];
  pm?: string;
  refresh?: string;
  refreshLog?: string;
  urc?: string;
  upg?: string;
  upgErr?: string;
  src?: string;
  sec?: string;
  secErr?: string;
  inst?: string;
  reboot?: string;
  end?: boolean;
}

/** What buildPatchScanScript() prints on a host, block for block. */
export function scanOutput(o: ScanFixture = {}): string {
  let out =
    val("ROOT", o.root ?? "0") +
    val("OS", o.os ?? '"Ubuntu 22.04.4 LTS"') +
    val("KRUN", o.krun ?? "5.15.0-91-generic") +
    val("KINST", (o.kinst ?? [o.krun ?? "5.15.0-91-generic"]).join("\n")) +
    val("PM", o.pm ?? "apt") +
    val("REFRESH", o.refresh ?? "ok") +
    val("REFRESHLOG", o.refreshLog ?? "") +
    val("URC", o.urc ?? "0") +
    val("UPG", o.upg ?? "Listing...\n") +
    val("UPGERR", o.upgErr ?? "") +
    val("SRC", o.src ?? "") +
    val("SEC", o.sec ?? "") +
    val("SECERR", o.secErr ?? "") +
    val("INST", o.inst ?? "") +
    val("REBOOT", o.reboot ?? "no");
  if (o.end !== false) out += "===END===\n";
  return out;
}

export interface ApplyFixture {
  pm?: string;
  refused?: string;
  cmd?: string;
  rc?: string;
  output?: string;
  outSize?: number;
}

/** What buildPatchApplyScript() prints on a host. */
export function applyOutput(o: ApplyFixture = {}): string {
  let out = val("PM", o.pm ?? "apt");
  if (o.refused) return `${out}===REFUSED:${o.refused}===\n===END===\n`;
  const output = o.output ?? "Reading package lists...\n0 upgraded, 0 newly installed.\n";
  out +=
    val("CMD", o.cmd ?? "apt-get update && apt-get -y dist-upgrade") +
    "===STARTED===\n" +
    val("RC", o.rc ?? "0") +
    val("OUTSIZE", String(o.outSize ?? Buffer.byteLength(output))) +
    val("OUT", output) +
    "===END===\n";
  return out;
}

export function execResult(stdout: string, extra: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 42,
    ...extra,
  };
}

export const APT_UPGRADABLE = [
  "Listing...",
  "openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]",
  "libssl3/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]",
  "curl/jammy-updates 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1ubuntu1.15]",
  "",
].join("\n");

export const DNF_CHECK_UPDATE = [
  "",
  "kernel.x86_64                          5.14.0-362.13.1.el9_3          baseos",
  "openssl-libs.x86_64                    1:3.0.7-25.el9_3               baseos",
  "python3-requests.noarch                2.25.1-8.el9                   appstream",
  "Obsoleting Packages",
  "grub2-tools.x86_64                     1:2.06-70.el9_3.1              baseos",
  "    grub2-tools.x86_64                 1:2.06-61.el9                  @anaconda",
  "",
].join("\n");

export const DNF_SECURITY = [
  "RHSA-2023:7549 Important/Sec. kernel-5.14.0-362.13.1.el9_3.x86_64",
  "RHSA-2024:0105 Moderate/Sec.  openssl-libs-1:3.0.7-25.el9_3.x86_64",
  "",
].join("\n");

export const RPM_INSTALLED = [
  "kernel.x86_64 5.14.0-284.11.1.el9_2",
  "kernel.x86_64 5.14.0-362.8.1.el9_3",
  "openssl-libs.x86_64 1:3.0.7-24.el9",
  "python3-requests.noarch 2.25.1-7.el9",
  "",
].join("\n");
