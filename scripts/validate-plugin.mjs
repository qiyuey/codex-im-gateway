import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
const deliverySkill = await readFile("skills/telegram-delivery/SKILL.md", "utf8");
const builtMcpServer = await readFile("dist/mcp/server.js", "utf8");
const builtDaemon = await readFile("dist/daemon.js", "utf8");

assert(manifest.name === "codex-im-gateway", "manifest name must match the plugin directory");
assert(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version), "invalid version");
assert(
  typeof manifest.description === "string" && manifest.description.length > 0,
  "missing description",
);
assert(typeof manifest.author?.name === "string", "missing author.name");
assert(manifest.skills === "./skills/", "skills must use the plugin-relative directory");
assert(manifest.mcpServers === "./.mcp.json", "MCP config path is invalid");

await Promise.all([
  access(".mcp.json"),
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
assert(!(await exists("hooks/hooks.json")), "automatic lifecycle hooks must remain disabled");

process.stdout.write("Plugin structure is valid.\n");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
