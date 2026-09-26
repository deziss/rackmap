import { describe, it, expect } from "vitest";
import { decideSslAlert, sslThresholdFor } from "../modules/health/ssl-checker.js";

/** ssl_expiring is edge-triggered at 30/14/7/1 days, once per threshold per certificate. */

describe("SSL expiry thresholds", () => {
  it("maps days remaining to the smallest threshold reached", () => {
    expect(sslThresholdFor(45)).toBeNull();
    expect(sslThresholdFor(30)).toBe(30);
    expect(sslThresholdFor(20)).toBe(30);
    expect(sslThresholdFor(14)).toBe(14);
    expect(sslThresholdFor(8)).toBe(14);
    expect(sslThresholdFor(7)).toBe(7);
    expect(sslThresholdFor(1)).toBe(1);
    expect(sslThresholdFor(-3)).toBe(1);
  });

  it("alerts once per threshold as a certificate counts down", () => {
    let last: number | null = null;
    const fired: number[] = [];
    for (const days of [40, 31, 30, 29, 20, 14, 13, 9, 7, 6, 2, 1, 0, -1]) {
      const d = decideSslAlert(days, last);
      if (d.alert) fired.push(d.nextThreshold!);
      last = d.nextThreshold;
    }
    expect(fired).toEqual([30, 14, 7, 1]);
  });

  it("a renewed certificate resets the state and resolves the incident", () => {
    const renewed = decideSslAlert(89, 7);
    expect(renewed).toEqual({ nextThreshold: null, alert: false, resolved: true });
    // …and the next expiry alerts again from the top.
    expect(decideSslAlert(30, renewed.nextThreshold)).toMatchObject({ alert: true, nextThreshold: 30 });
  });

  it("a renewal that still lands inside a window re-alerts at that window", () => {
    expect(decideSslAlert(25, 7)).toEqual({ nextThreshold: 30, alert: true, resolved: false });
  });

  it("stays quiet while nothing changes", () => {
    expect(decideSslAlert(12, 14)).toEqual({ nextThreshold: 14, alert: false, resolved: false });
    expect(decideSslAlert(60, null)).toEqual({ nextThreshold: null, alert: false, resolved: false });
  });
});
