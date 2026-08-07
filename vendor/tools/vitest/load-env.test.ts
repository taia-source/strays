import { describe, expect, it } from "vitest";
import { applyEnv, parseEnv } from "./load-env.js";

describe("parseEnv", () => {
  it("reads plain assignments", () => {
    expect(parseEnv("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnv("# note\n\nA=1\n   \n# A=2")).toEqual({ A: "1" });
  });

  it("strips one layer of matching quotes", () => {
    expect(parseEnv(`A="q"\nB='s'\nC=bare`)).toEqual({ A: "q", B: "s", C: "bare" });
  });

  it("keeps a '#' inside a value rather than truncating it", () => {
    // A password or URL fragment containing '#' is real; treating it as a comment would
    // silently corrupt the credential.
    expect(parseEnv("PASS=abc#def")).toEqual({ PASS: "abc#def" });
  });

  it("keeps '=' inside a value", () => {
    // Base64 secrets end in '='. Splitting on every '=' would truncate them.
    expect(parseEnv("TOKEN=abc=def==")).toEqual({ TOKEN: "abc=def==" });
  });

  it("handles an `export ` prefix", () => {
    expect(parseEnv("export A=1")).toEqual({ A: "1" });
  });

  it("skips malformed keys rather than importing garbage", () => {
    expect(parseEnv("=novalue\n123BAD=x\nOK=1")).toEqual({ OK: "1" });
  });

  it("preserves an empty value", () => {
    expect(parseEnv("EMPTY=")).toEqual({ EMPTY: "" });
  });
});

describe("applyEnv", () => {
  it("sets variables that are absent", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnv({ A: "1" }, env)).toEqual(["A"]);
    expect(env.A).toBe("1");
  });

  it("never overwrites a variable that is already set", () => {
    // The important one: a local .env silently replacing a real CI secret would be a
    // genuinely nasty bug, and the wrong value would be used everywhere without warning.
    const env: NodeJS.ProcessEnv = { A: "from-ci" };
    expect(applyEnv({ A: "from-file" }, env)).toEqual([]);
    expect(env.A).toBe("from-ci");
  });

  it("treats an empty existing value as unset", () => {
    const env: NodeJS.ProcessEnv = { A: "" };
    applyEnv({ A: "real" }, env);
    expect(env.A).toBe("real");
  });
});

/**
 * The regression this whole file exists for.
 *
 * `rpcUrl(4663)` reads `TAIA_RPC_4663` and otherwise falls back to the public endpoint.
 * Nothing loaded the env file, so the override never applied and every "live" test hit the
 * public RPC — which dropped TLS handshakes (`SSL alert number 40`) and failed about 1 run
 * in 5. Six consecutive runs passed once this loader was wired in.
 */
describe("the variable the live tests depend on", () => {
  it("is present once the loader has run", () => {
    expect(
      process.env.TAIA_RPC_4663,
      "TAIA_RPC_4663 must be set or live tests silently use the flaky public RPC",
    ).toBeTruthy();
  });

  it("points at a provider endpoint rather than the public default", () => {
    expect(process.env.TAIA_RPC_4663).not.toContain("rpc.mainnet.chain.robinhood.com");
  });
});
