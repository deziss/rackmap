import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isLoopbackHost, resolveTargetHost } from "../lib/target-resolver.js";

describe("target-resolver", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("isLoopbackHost", () => {
    it("identifies localhost variations", () => {
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("LOCALHOST")).toBe(true);
      expect(isLoopbackHost("localhost.localdomain")).toBe(true);
    });

    it("identifies IPv4 loopback and all-zero addresses", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("127.0.1.1")).toBe(true);
      expect(isLoopbackHost("127.10.20.30")).toBe(true);
      expect(isLoopbackHost("0.0.0.0")).toBe(true);
    });

    it("identifies IPv6 loopback", () => {
      expect(isLoopbackHost("::1")).toBe(true);
      expect(isLoopbackHost("[::1]")).toBe(true);
    });

    it("does not flag remote IPs or hostnames as loopback", () => {
      expect(isLoopbackHost("192.168.1.100")).toBe(false);
      expect(isLoopbackHost("10.0.0.5")).toBe(false);
      expect(isLoopbackHost("172.16.0.1")).toBe(false);
      expect(isLoopbackHost("google.com")).toBe(false);
      expect(isLoopbackHost("my-server.local")).toBe(false);
    });
  });

  describe("resolveTargetHost", () => {
    it("returns unchanged if not in docker", () => {
      delete process.env.IN_DOCKER;
      delete process.env.DOCKER_HOST_OVERRIDE;
      expect(resolveTargetHost("127.0.0.1")).toBe("127.0.0.1");
      expect(resolveTargetHost("localhost")).toBe("localhost");
      expect(resolveTargetHost("192.168.1.50")).toBe("192.168.1.50");
    });

    it("resolves loopback to DOCKER_HOST_OVERRIDE when set", () => {
      process.env.IN_DOCKER = "true";
      process.env.DOCKER_HOST_OVERRIDE = "10.0.2.2";
      expect(resolveTargetHost("127.0.0.1")).toBe("10.0.2.2");
      expect(resolveTargetHost("0.0.0.0")).toBe("10.0.2.2");
      expect(resolveTargetHost("localhost")).toBe("10.0.2.2");
    });

    it("leaves non-loopback host unchanged even in docker", () => {
      process.env.IN_DOCKER = "true";
      process.env.DOCKER_HOST_OVERRIDE = "10.0.2.2";
      expect(resolveTargetHost("192.168.1.100")).toBe("192.168.1.100");
      expect(resolveTargetHost("api.nuvo.ai")).toBe("api.nuvo.ai");
    });
  });
});
