import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const hookConfig = JSON.parse(await readFile("hooks/hooks.json", "utf8"));
const buildInfo = await readFile("src/core/build-info.ts", "utf8");
const deliverySkill = await readFile("skills/telegram-delivery/SKILL.md", "utf8");
const builtMcpServer = await readFile("dist/mcp/server.js", "utf8");
const builtDaemon = await readFile("dist/daemon.js", "utf8");
const builtStopHook = await readFile("dist/hooks/stop.js", "utf8");
const packagedManifest = JSON.parse(
  await readFile("artifacts/plugin/.codex-plugin/plugin.json", "utf8"),
);

assert(manifest.name === "codex-im", "manifest name must match the plugin directory");
assert(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version), "invalid version");
assert(
  manifest.version.split("+")[0] === packageJson.version,
  "plugin and runtime base versions must match",
);
assert(
  buildInfo.includes(`GATEWAY_RUNTIME_VERSION = "${packageJson.version}"`),
  "runtime build info version is stale",
);
assert(
  typeof manifest.description === "string" && manifest.description.length > 0,
  "missing description",
);
assert(typeof manifest.author?.name === "string", "missing author.name");
assert(manifest.skills === "./skills/", "skills must use the plugin-relative directory");
assert(
  JSON.stringify(manifest.mcpServers) ===
    JSON.stringify({
      gateway: {
        command: "node",
        args: ["./dist/mcp/server.js"],
        cwd: ".",
      },
    }),
  "inline MCP config is invalid",
);

await Promise.all([
  access("hooks/hooks.json"),
  access("skills/gateway/SKILL.md"),
  access("skills/telegram-delivery/SKILL.md"),
]);

assert(deliverySkill.includes("telegram_deliver"), "delivery skill must name the MCP tool");
assert(deliverySkill.includes("exactly once"), "delivery skill must require one final enqueue");
assert(
  deliverySkill.includes("GFM-compatible Rich"),
  "delivery skill must define Rich Markdown input",
);
assert(builtMcpServer.includes("telegram_deliver"), "built MCP server is missing delivery tool");
assert(
  builtDaemon.includes("sendRichMessage") && builtDaemon.includes("rich_message"),
  "built daemon is missing Telegram Rich Message delivery",
);
const stopHook = hookConfig.hooks?.Stop?.[0]?.hooks?.[0];
assert(stopHook?.type === "command", "missing Stop command hook");
assert(stopHook.command.includes("CODEX_IM_DATA_DIR"), "Stop hook data dir is not shared");
assert(stopHook.command.includes("$PLUGIN_ROOT"), "Stop hook must resolve from PLUGIN_ROOT");
assert(
  stopHook.commandWindows.includes("CODEX_IM_DATA_DIR"),
  "Windows Stop hook data dir is not shared",
);
assert(builtStopHook.includes("unable to queue completion event"), "built Stop hook is missing");
assert(packagedManifest.version === manifest.version, "packaged plugin version is stale");
assert(
  JSON.stringify(packagedManifest.mcpServers) === JSON.stringify(manifest.mcpServers),
  "packaged inline MCP config is stale",
);
await Promise.all([
  access("artifacts/plugin/dist/hooks/stop.js"),
  access("artifacts/plugin/dist/mcp/server.js"),
  access("artifacts/runtime/dist/daemon.js"),
  access("artifacts/runtime/dist/cli.js"),
]);
await assertMissing(".mcp.json", "root MCP config triggers project migration prompts");
await assertMissing("artifacts/plugin/.mcp.json", "plugin artifact must use the inline MCP config");
await assertMissing(
  "artifacts/plugin/dist/daemon.js",
  "plugin artifact must not contain the supervised daemon",
);
await assertMissing(
  "artifacts/runtime/.codex-plugin/plugin.json",
  "runtime artifact must not masquerade as a Codex plugin",
);

process.stdout.write("Plugin structure is valid.\n");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertMissing(path, message) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(message);
}
