import { describe, expect, it } from "vitest";
import { renderLaunchdPlist } from "../src/runtime/launchd-service.js";

describe("renderLaunchdPlist", () => {
  it("renders a supervised service with absolute escaped paths", () => {
    const plist = renderLaunchdPlist({
      runtimeRoot: "/Applications/Gateway & Runtime",
      envFile: "/private/config<prod>.env",
      nodePath: "/opt/homebrew/bin/node",
      homeDirectory: "/Users/tester",
      dataDirectory: "/Users/tester/Library/Application Support/Gateway",
    });

    expect(plist).toContain("com.qiyuey.codex-im");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("/opt/homebrew/bin/node");
    expect(plist).toContain("/Applications/Gateway &amp; Runtime/dist/daemon.js");
    expect(plist).toContain("--env-file-if-exists=/private/config&lt;prod&gt;.env");
  });
});
