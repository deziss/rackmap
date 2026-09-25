import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { PATCH_PACKAGES_MAX } from "@inv/shared";
import {
  APT_UPGRADABLE,
  DNF_CHECK_UPDATE,
  DNF_SECURITY,
  RPM_INSTALLED,
  applyOutput,
  scanOutput,
} from "./patch-fixtures.js";

/**
 * Pure parsing and script generation for fleet patch management: package
 * manager output fixtures (apt, dnf, yum, zypper), kernel comparison and the
 * reboot-required rules. No database, no SSH.
 */

const {
  buildPatchApplyScript,
  buildPatchScanScript,
  compareVersions,
  countZypperSecurityPatches,
  isKernelNewer,
  kernelFlavour,
  newestKernel,
  parseAptUpgradable,
  parsePatchApplyOutput,
  parsePatchScanOutput,
  parseRpmCheckUpdate,
  parseRpmInstalled,
  parseRpmSecurityList,
  parseZypperUpdates,
} = await import("../services/patch.service.js");

const YUM_CHECK_UPDATE = [
  "Loaded plugins: fastestmirror",
  "Loading mirror speeds from cached hostfile",
  " * base: mirror.example.com",
  "",
  "NetworkManager-libnm-very-long-package-name.x86_64",
  "                                      1:1.18.8-2.el7_9               updates",
  "bash.x86_64                           4.2.46-35.el7_9                updates",
  "Security: kernel-3.10.0-1160.105.1.el7.x86_64 is an installed security update",
  "",
].join("\n");

const YUM_SECURITY = [
  "Loaded plugins: fastestmirror",
  "RHSA-2023:1234 Important/Sec. bash-4.2.46-35.el7_9.x86_64",
  "updateinfo list done",
].join("\n");

const DNF5_SECURITY = [
  "Name                   Type        Severity  Package                                Issued",
  "FEDORA-2024-0a1b2c3d4e security    Moderate  curl-8.6.0-7.fc40.x86_64               2024-05-01 00:00:00",
].join("\n");

const ZYPPER_LU = [
  "Loading repository data...",
  "Reading installed packages...",
  "S | Repository                          | Name          | Current Version        | Available Version      | Arch",
  "--+-------------------------------------+---------------+------------------------+------------------------+-------",
  "v | SLE-Module-Basesystem15-SP5-Updates | libopenssl1_1 | 1.1.1l-150500.17.19.1  | 1.1.1l-150500.17.22.1  | x86_64",
  "v | SLE-Module-Basesystem15-SP5-Updates | vim           | 9.0.2103-150500.20.6.1 | 9.0.2189-150500.20.9.1 | x86_64",
].join("\n");

const ZYPPER_LP = [
  "Loading repository data...",
  "Reading installed packages...",
  "",
  "Repository                          | Name                                        | Category | Severity  | Interactive | Status | Summary",
  "------------------------------------+---------------------------------------------+----------+-----------+-------------+--------+--------------------------------",
  "SLE-Module-Basesystem15-SP5-Updates | SUSE-SLE-Module-Basesystem-15-SP5-2024-1234 | security | important | ---         | needed | Security update for openssl-1_1",
  "SLE-Module-Basesystem15-SP5-Updates | SUSE-SLE-Module-Basesystem-15-SP5-2024-1300 | security | moderate  | ---         | needed | Security update for vim",
  "",
  "Found 2 applicable patches:",
  "2 patches needed (2 security patches)",
].join("\n");

describe("apt", () => {
  it("parses apt list --upgradable and flags -security suites", () => {
    const pkgs = parseAptUpgradable(APT_UPGRADABLE);
    expect(pkgs).toHaveLength(3);
    expect(pkgs[0]).toMatchObject({ name: "openssl", current: "3.0.2-0ubuntu1.14", available: "3.0.2-0ubuntu1.15", security: true });
    expect(pkgs.find((p) => p.name === "curl")?.security).toBe(false);
  });

  it("recognises Debian's stable-security suite and ignores noise lines", () => {
    const pkgs = parseAptUpgradable(
      "WARNING: apt does not have a stable CLI interface.\nListing... Done\nlibc6/stable-security 2.36-9+deb12u4 amd64 [upgradable from: 2.36-9+deb12u3]\n",
    );
    expect(pkgs).toEqual([
      { name: "libc6", current: "2.36-9+deb12u3", available: "2.36-9+deb12u4", arch: "amd64", security: true },
    ]);
  });

  it("builds a full status for an apt host with reboot-required set", () => {
    const r = parsePatchScanOutput(scanOutput({ upg: APT_UPGRADABLE, reboot: "yes" }));
    expect(r).toMatchObject({
      status: "ok",
      error: null,
      packageManager: "apt",
      osPretty: "Ubuntu 22.04.4 LTS",
      upgradableCount: 3,
      securityCount: 2,
      rebootRequired: true,
      ranAsRoot: true,
    });
    // Security updates first.
    expect(r.packages.map((p) => p.security)).toEqual([true, true, false]);
  });

  it("is an error when apt list fails", () => {
    const r = parsePatchScanOutput(scanOutput({ urc: "100", upgErr: "E: Could not open lock file /var/lib/dpkg/lock-frontend\n" }));
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/apt list --upgradable failed \(exit 100\).*lock/);
  });
});

describe("dnf / yum", () => {
  it("parses check-update rows and stops at Obsoleting Packages", () => {
    const rows = parseRpmCheckUpdate(DNF_CHECK_UPDATE);
    expect(rows.map((r) => `${r.name}.${r.arch}`)).toEqual(["kernel.x86_64", "openssl-libs.x86_64", "python3-requests.noarch"]);
    expect(rows[1]!.available).toBe("1:3.0.7-25.el9_3");
  });

  it("joins yum's wrapped long names and skips plugin / Security: noise", () => {
    const rows = parseRpmCheckUpdate(YUM_CHECK_UPDATE);
    expect(rows).toEqual([
      { name: "NetworkManager-libnm-very-long-package-name", arch: "x86_64", available: "1:1.18.8-2.el7_9" },
      { name: "bash", arch: "x86_64", available: "4.2.46-35.el7_9" },
    ]);
  });

  it("reads package names out of updateinfo NEVRAs (dnf 4, yum 3, dnf 5)", () => {
    expect([...parseRpmSecurityList(DNF_SECURITY)]).toEqual(["kernel.x86_64", "openssl-libs.x86_64"]);
    expect([...parseRpmSecurityList(YUM_SECURITY)]).toEqual(["bash.x86_64"]);
    expect([...parseRpmSecurityList(DNF5_SECURITY)]).toEqual(["curl.x86_64"]);
  });

  it("keeps the newest installed version per name.arch", () => {
    const inst = parseRpmInstalled(RPM_INSTALLED);
    expect(inst.get("kernel.x86_64")).toBe("5.14.0-362.8.1.el9_3");
    expect(inst.get("openssl-libs.x86_64")).toBe("1:3.0.7-24.el9");
  });

  it("builds a dnf status with security flags and current versions", () => {
    const r = parsePatchScanOutput(
      scanOutput({
        pm: "dnf",
        os: '"Rocky Linux 9.3 (Blue Onyx)"',
        krun: "5.14.0-362.8.1.el9_3.x86_64",
        kinst: ["5.14.0-362.8.1.el9_3.x86_64", "5.14.0-284.11.1.el9_2.x86_64", "0-rescue-0123456789abcdef"],
        urc: "100",
        upg: DNF_CHECK_UPDATE,
        src: "0",
        sec: DNF_SECURITY,
        inst: RPM_INSTALLED,
        reboot: "no",
      }),
    );
    expect(r).toMatchObject({ status: "ok", packageManager: "dnf", upgradableCount: 3, securityCount: 2, rebootRequired: false });
    expect(r.kernelLatest).toBe("5.14.0-362.8.1.el9_3.x86_64");
    expect(r.packages.find((p) => p.name === "openssl-libs")).toEqual({
      name: "openssl-libs",
      current: "1:3.0.7-24.el9",
      available: "1:3.0.7-25.el9_3",
      security: true,
    });
  });

  it("treats check-update exit 0 as up to date and exit 1 as an error", () => {
    expect(parsePatchScanOutput(scanOutput({ pm: "yum", urc: "0", upg: "", src: "0" }))).toMatchObject({
      status: "ok",
      upgradableCount: 0,
      securityCount: 0,
    });
    const bad = parsePatchScanOutput(scanOutput({ pm: "yum", urc: "1", upgErr: "Error: Cannot find a valid baseurl for repo: base\n" }));
    expect(bad.status).toBe("error");
    expect(bad.error).toMatch(/yum check-update failed \(exit 1\).*baseurl/);
  });

  it("warns, but still reports updates, when security advisories are unavailable", () => {
    const r = parsePatchScanOutput(scanOutput({ pm: "yum", urc: "100", upg: YUM_CHECK_UPDATE, src: "1", secErr: "No such command: updateinfo" }));
    expect(r.status).toBe("ok");
    expect(r.upgradableCount).toBe(2);
    expect(r.securityCount).toBe(0);
    expect(r.error).toMatch(/Security advisories are not available/);
  });
});

describe("zypper", () => {
  it("parses list-updates tables", () => {
    expect(parseZypperUpdates(ZYPPER_LU)).toEqual([
      { name: "libopenssl1_1", current: "1.1.1l-150500.17.19.1", available: "1.1.1l-150500.17.22.1", arch: "x86_64", security: false },
      { name: "vim", current: "9.0.2103-150500.20.6.1", available: "9.0.2189-150500.20.9.1", arch: "x86_64", security: false },
    ]);
  });

  it("counts needed security patches", () => {
    expect(countZypperSecurityPatches(ZYPPER_LP)).toBe(2);
  });

  it("builds a zypper status; exit 100+ is informational", () => {
    const r = parsePatchScanOutput(
      scanOutput({
        pm: "zypper",
        krun: "5.14.21-150500.55.39-default",
        kinst: ["5.14.21-150500.55.39-default", "5.14.21-150500.55.44-default"],
        urc: "0",
        upg: ZYPPER_LU,
        src: "101",
        sec: ZYPPER_LP,
        reboot: "unknown",
      }),
    );
    expect(r).toMatchObject({ status: "ok", upgradableCount: 2, securityCount: 2, kernelLatest: "5.14.21-150500.55.44-default" });
    // No definite flag from the host, but a newer kernel is installed.
    expect(r.rebootRequired).toBe(true);
  });
});

describe("kernels and reboot flags", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("5.15.0-100-generic", "5.15.0-91-generic")).toBeGreaterThan(0);
    expect(compareVersions("5.14.0-362.13.1.el9_3.x86_64", "5.14.0-362.8.1.el9_3.x86_64")).toBeGreaterThan(0);
    expect(compareVersions("6.1.0-18-amd64", "6.1.0-18-amd64")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
  });

  it("derives kernel flavours", () => {
    expect(kernelFlavour("5.15.0-91-generic")).toBe("-generic");
    expect(kernelFlavour("6.1.0-18-cloud-amd64")).toBe("-cloud-amd64");
    expect(kernelFlavour("5.14.21-150500.55.39-default")).toBe("-default");
    expect(kernelFlavour("5.14.0-362.8.1.el9_3.x86_64")).toBe(".x86_64");
    expect(kernelFlavour("4.18.0-513.el8.x86_64+debug")).toBe(".x86_64+debug");
  });

  it("picks the newest kernel of the running flavour", () => {
    expect(newestKernel("5.15.0-89-generic", ["5.15.0-89-generic", "5.15.0-91-generic", "5.15.0-105-lowlatency"])).toBe(
      "5.15.0-91-generic",
    );
    expect(newestKernel("6.1.0-17-amd64", ["6.1.0-17-amd64", "6.1.0-18-amd64", "6.1.0-20-cloud-amd64"])).toBe("6.1.0-18-amd64");
    expect(newestKernel("5.14.0-362.8.1.el9_3.x86_64", ["0-rescue-abc", "5.14.0-362.13.1.el9_3.x86_64", "5.14.0-362.8.1.el9_3.x86_64"])).toBe(
      "5.14.0-362.13.1.el9_3.x86_64",
    );
    expect(newestKernel("5.15.0-91-generic", [])).toBeNull();
    expect(isKernelNewer("5.15.0-91-generic", "5.15.0-89-generic")).toBe(true);
    expect(isKernelNewer("5.15.0-89-generic", "5.15.0-89-generic")).toBe(false);
    expect(isKernelNewer(null, "5.15.0-89-generic")).toBe(false);
  });

  it("uses the host's reboot flag when definite, the kernel comparison otherwise", () => {
    const newer = { krun: "5.15.0-89-generic", kinst: ["5.15.0-89-generic", "5.15.0-91-generic"] };
    expect(parsePatchScanOutput(scanOutput({ ...newer, reboot: "yes" })).rebootRequired).toBe(true);
    expect(parsePatchScanOutput(scanOutput({ ...newer, reboot: "no" })).rebootRequired).toBe(false);
    expect(parsePatchScanOutput(scanOutput({ ...newer, reboot: "unknown" })).rebootRequired).toBe(true);
    expect(parsePatchScanOutput(scanOutput({ reboot: "unknown" })).rebootRequired).toBe(false);
    expect(parsePatchScanOutput(scanOutput({ reboot: "yes" })).rebootRequired).toBe(true);
  });
});

describe("scan output edge cases", () => {
  it("reports an unknown package manager as unsupported", () => {
    const r = parsePatchScanOutput(scanOutput({ pm: "unknown" }));
    expect(r.status).toBe("unsupported");
    expect(r.packageManager).toBe("unknown");
    expect(r.error).toMatch(/No supported package manager/);
  });

  it("is an error when the output is incomplete or the host lacks base64", () => {
    expect(parsePatchScanOutput(scanOutput({ end: false })).status).toBe("error");
    const fatal = parsePatchScanOutput("===FATAL:NO_BASE64===\n");
    expect(fatal.status).toBe("error");
    expect(fatal.error).toMatch(/base64/);
    expect(parsePatchScanOutput("").status).toBe("error");
  });

  it("keeps status ok but warns when the refresh failed or ran without root", () => {
    const failed = parsePatchScanOutput(scanOutput({ refresh: "failed", refreshLog: "E: Failed to fetch http://archive.example.com\n" }));
    expect(failed.status).toBe("ok");
    expect(failed.error).toMatch(/could not be refreshed.*Failed to fetch/);
    const noroot = parsePatchScanOutput(scanOutput({ refresh: "noroot", root: "1000" }));
    expect(noroot.error).toMatch(/without root/);
    expect(noroot.ranAsRoot).toBe(false);
  });

  it("caps the stored list at PATCH_PACKAGES_MAX with security updates first, counting all", () => {
    const lines = ["Listing..."];
    for (let i = 0; i < PATCH_PACKAGES_MAX + 50; i++) {
      lines.push(`pkg${String(i).padStart(4, "0")}/jammy-updates 1.${i} amd64 [upgradable from: 1.0]`);
    }
    lines.push("zzz-last/jammy-security 2.0 amd64 [upgradable from: 1.0]");
    const r = parsePatchScanOutput(scanOutput({ upg: lines.join("\n") }));
    expect(r.upgradableCount).toBe(PATCH_PACKAGES_MAX + 51);
    expect(r.securityCount).toBe(1);
    expect(r.packages).toHaveLength(PATCH_PACKAGES_MAX);
    expect(r.packages[0]!.name).toBe("zzz-last");
  });

  it("ignores lines that only look like markers", () => {
    const out = scanOutput({ upg: "===END===\n===FATAL:X===\n" + APT_UPGRADABLE });
    // The listing travels base64-encoded, so its content can never become a header.
    expect(parsePatchScanOutput(out)).toMatchObject({ status: "ok", upgradableCount: 3 });
  });
});

describe("apply output", () => {
  it("parses a finished run", () => {
    const r = parsePatchApplyOutput(applyOutput({ rc: "0", output: "Setting up openssl ...\n" }));
    expect(r).toMatchObject({ packageManager: "apt", started: true, exitCode: 0, output: "Setting up openssl ...\n", complete: true, outputTruncated: false });
  });

  it("flags a capped output and a refusal", () => {
    expect(parsePatchApplyOutput(applyOutput({ outSize: 10 * 1024 * 1024 })).outputTruncated).toBe(true);
    const refused = parsePatchApplyOutput(applyOutput({ refused: "NO_UNATTENDED_UPGRADE" }));
    expect(refused).toMatchObject({ refused: "NO_UNATTENDED_UPGRADE", started: false });
  });
});

describe("generated scripts", () => {
  const shSyntaxOk = (script: string) => {
    execFileSync("sh", ["-n"], { input: script });
    return true;
  };

  it("are valid POSIX sh", () => {
    expect(shSyntaxOk(buildPatchScanScript({ refresh: true }))).toBe(true);
    expect(shSyntaxOk(buildPatchScanScript({ refresh: false }))).toBe(true);
    expect(shSyntaxOk(buildPatchApplyScript("security"))).toBe(true);
    expect(shSyntaxOk(buildPatchApplyScript("all"))).toBe(true);
  });

  it("only refresh the package index when asked and running as root", () => {
    const withRefresh = buildPatchScanScript({ refresh: true });
    expect(withRefresh).toMatch(/^REFRESH=1$/m);
    expect(withRefresh).toContain('if [ "$U" = 0 ]; then');
    expect(withRefresh).toContain("apt-get -q update");
    expect(buildPatchScanScript({ refresh: false })).toMatch(/^REFRESH=0$/m);
  });

  it("apply the documented commands and never reboot", () => {
    const sec = buildPatchApplyScript("security");
    const all = buildPatchApplyScript("all");
    expect(sec).toContain("unattended-upgrade -v");
    expect(sec).toContain("REFUSED:NO_UNATTENDED_UPGRADE");
    expect(sec).toContain('"$PM" -y upgrade --security');
    expect(sec).toContain("zypper -n patch -g security");
    expect(all).toContain("apt-get -y -o Dpkg::Options::=--force-confold");
    expect(all).toContain("dist-upgrade");
    expect(all).toContain('"$PM" -y upgrade >>');
    expect(all).toContain("zypper -n update");
    for (const s of [sec, all, buildPatchScanScript({ refresh: true })]) {
      expect(s).not.toMatch(/\b(reboot|shutdown|systemctl\s+(reboot|poweroff|kexec))\b(?!-)/);
    }
  });
});
