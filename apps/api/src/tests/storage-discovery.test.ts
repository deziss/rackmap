import { describe, it, expect } from "vitest";
import { formatStorageBytes, parseStorageSizeToBytes, parseDiscoveryOutput } from "../services/discovery.service.js";
import { calculateTotalStorageFromMetrics } from "../services/metrics.service.js";

describe("Storage Calculation & Formatting", () => {
  describe("formatStorageBytes", () => {
    it("formats 0 or negative bytes as 0GB", () => {
      expect(formatStorageBytes(0)).toBe("0GB");
      expect(formatStorageBytes(-100)).toBe("0GB");
    });

    it("formats sub-terabyte sizes in GB", () => {
      // 512,110,190,592 bytes = 476.94 GiB -> 477GB
      expect(formatStorageBytes(512110190592)).toBe("477GB");
      // 256 GiB
      expect(formatStorageBytes(256 * 1024 * 1024 * 1024)).toBe("256GB");
    });

    it("formats terabyte sizes in TB", () => {
      // 1,000,204,886,016 bytes = 1 TB
      expect(formatStorageBytes(1000204886016)).toBe("1TB");
      // 2,000,398,934,016 bytes = 2 TB
      expect(formatStorageBytes(2000398934016)).toBe("2TB");
      // 1.5 TB
      expect(formatStorageBytes(1.5 * 1e12)).toBe("1.5TB");
    });
  });

  describe("parseStorageSizeToBytes", () => {
    it("parses GB and TB string sizes to bytes", () => {
      expect(parseStorageSizeToBytes("512GB")).toBe(512 * 1024 * 1024 * 1024);
      expect(parseStorageSizeToBytes("2TB")).toBe(2 * 1024 * 1024 * 1024 * 1024);
      expect(parseStorageSizeToBytes("1.5 TB")).toBe(Math.round(1.5 * 1024 * 1024 * 1024 * 1024));
      expect(parseStorageSizeToBytes("")).toBe(0);
    });
  });

  describe("parseDiscoveryOutput with multiple disks", () => {
    it("sums multiple physical disks into total storage", () => {
      const mockDiscoveryOutput = `
===CPU===
Model name: Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz
CPU(s): 48
Thread(s) per core: 2
===MEM===
MemTotal:       131802368 kB
===OS===
PRETTY_NAME="Ubuntu 22.04.4 LTS"
===GPU===
NONE
===DISK===
NAME            SIZE TYPE MODEL
loop0           4096 loop 
loop1      202833920 loop 
nvme0n1 512110190592 disk Samsung PM9A1 512GB
sda    1000204886016 disk Samsung SSD 870 1TB
sr0       1048576 rom QEMU DVD-ROM
===UPTIME===
up 14 days, 3 hours
===UNAME===
Linux 5.15.0-107-generic x86_64
`;

      const info = parseDiscoveryOutput(mockDiscoveryOutput, "server-01");
      expect(info.cpuCores).toBe(48);
      expect(info.disks.length).toBe(3); // nvme0n1, sda, and sr0
      expect(info.disks[0]?.name).toBe("nvme0n1");
      expect(info.disks[0]?.size).toBe("477GB");
      expect(info.disks[1]?.name).toBe("sda");
      expect(info.disks[1]?.size).toBe("1TB");

      // Total storage sums nvme0n1 (512GB) + sda (1TB) = 1.5TB
      expect(info.totalStorage).toBe("1.5TB");
      expect(info.totalStorageBytes).toBe(512110190592 + 1000204886016);
    });

    it("accurately parses single disk servers", () => {
      const singleDiskOutput = `
===CPU===
Model name: AMD Ryzen 9 5900X
CPU(s): 12
===MEM===
MemTotal:       16384000 kB
===OS===
PRETTY_NAME="Ubuntu 24.04 LTS"
===GPU===
NONE
===DISK===
NAME            SIZE TYPE MODEL
nvme0n1 512110190592 disk UMIS RPJTJ512MKP1QDQ
===UPTIME===
up 2 hours
===UNAME===
Linux 6.8.0-generic x86_64
`;

      const info = parseDiscoveryOutput(singleDiskOutput, "local");
      expect(info.disks.length).toBe(1);
      expect(info.totalStorage).toBe("477GB");
      expect(info.totalStorageBytes).toBe(512110190592);
    });
  });

  describe("calculateTotalStorageFromMetrics", () => {
    it("sums filesystem sizes properly", () => {
      const mockDisks = [
        { mount: "/", usedBytes: 20 * 1e9, totalBytes: 100 * 1e9, pct: 20 },
        { mount: "/data", usedBytes: 400 * 1e9, totalBytes: 900 * 1e9, pct: 44 },
      ];
      const res = calculateTotalStorageFromMetrics(mockDisks);
      expect(res.totalBytes).toBe(1000 * 1e9);
      expect(res.formatted).toBe("1TB");
    });
  });
});
