import { describe, it, expect } from "vitest";
import { withLoopbackAliases } from "../env.js";

/**
 * A browser's Origin header is whatever is in the address bar, and an origin check compares
 * it as a string. `http://localhost:8080` and `http://127.0.0.1:8080` are the same server and
 * different origins, so a single-machine install that names one of them used to answer the
 * other with a bare 403 at sign-in — the page loads, the password is right, and nothing says
 * why. These are the guarantees that stop that from coming back.
 */
describe("withLoopbackAliases", () => {
  const ALL = [
    "http://localhost:3123",
    "http://127.0.0.1:3123",
    "http://[::1]:3123",
    "http://0.0.0.0:3123",
  ];

  it.each(ALL)("expands %s to every loopback spelling on the same port", (origin) => {
    expect(withLoopbackAliases(origin).sort()).toEqual([...ALL].sort());
  });

  it("keeps the port out when the origin has none", () => {
    expect(withLoopbackAliases("http://localhost")).toEqual([
      "http://localhost",
      "http://127.0.0.1",
      "http://[::1]",
      "http://0.0.0.0",
    ]);
  });

  it("keeps the scheme — https loopback does not gain http aliases", () => {
    expect(withLoopbackAliases("https://localhost:3123")).not.toContain("http://localhost:3123");
    expect(withLoopbackAliases("https://localhost:3123")).toContain("https://127.0.0.1:3123");
  });

  it("never widens a real deployment", () => {
    // The whole point of the narrowing: a public origin must stay exactly as written, or
    // this would be a CSRF hole rather than a usability fix.
    expect(withLoopbackAliases("https://rackmap.example.com")).toEqual([
      "https://rackmap.example.com",
    ]);
    expect(withLoopbackAliases("http://10.0.0.5:8080")).toEqual(["http://10.0.0.5:8080"]);
    expect(withLoopbackAliases("http://localhost.evil.com:3123")).toEqual([
      "http://localhost.evil.com:3123",
    ]);
  });

  it("passes a non-URL through untouched rather than throwing at boot", () => {
    expect(withLoopbackAliases("localhost:3123")).toEqual(["localhost:3123"]);
    expect(withLoopbackAliases("")).toEqual([""]);
  });
});
