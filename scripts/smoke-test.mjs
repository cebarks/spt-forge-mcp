#!/usr/bin/env node
// Optional, dependency-free smoke test: spawns dist/index.js, speaks MCP JSON-RPC over stdio,
// calls every tool against the live Forge API and checks the text output.
//
//   npm run build && npm run smoke
//
// Expectations use real Forge data (SAIN, BigBrain, ...) that was correct on 2026-11-25 and may
// drift over time. Behind an HTTPS proxy, run with NODE_USE_ENV_PROXY=1 so Node's fetch uses it.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CALL_TIMEOUT_MS = 120_000;

const EXPECTED_TOOLS = [
  "search_mods", "get_mod", "get_mod_versions", "check_mod_updates", "resolve_mod_dependencies",
  "search_addons", "get_addon", "list_categories", "get_spt_versions", "ping", "get_addon_versions",
  "resolve_addon_dependencies", "get_category", "get_mod_file_tree", "get_addon_file_tree",
];

// [tool, arguments, strings the output must contain, expect isError]
const CASES = [
  ["ping", {}, ["pong"]],
  ["search_mods", { query: "sain", per_page: 3 }, ["Found", "SAIN"]],
  ["search_mods", { filter_guid: "me.sol.sain" }, ["(ID: 791)"]],
  ["get_mod", { mod_id: 791 }, ["Category: Bots", "Recent Versions"]],
  ["get_mod_versions", { mod_id: 791, per_page: 3, include: "dependencies,virus_total_links" },
    ["v4.5.1", "Waypoints", "BigBrain", "VirusTotal: Client", "Changelog:"]],
  ["get_mod_versions", { mod_id: 791, filter_spt_version: "4.1.6", sort: "-version" }, ["v4.5.1"]],
  ["get_mod_file_tree", { mod_id: 791, version_id: 15192 }, ["9 files", "BepInEx/plugins/SAIN/SAIN.dll"]],
  ["check_mod_updates", { mods: "791:4.4.3,791:4.5.1", spt_version: "4.1.6" },
    ["## Updates Available", "4.4.3 → 4.5.1", "## Up to Date"]],
  ["check_mod_updates", { mods: "791:4.4.3,902:1.4.0", spt_version: "4.1.6" },
    ["## Blocked Updates", "requires ~1.4.0"]],
  ["check_mod_updates", { mods: "649:2.0.4,nope.guid:1.0.0", spt_version: "4.1.6" },
    ["## Incompatible with SPT", "no version for SPT 4.1.6", "Not found on the Forge: nope.guid:1.0.0"]],
  ["resolve_mod_dependencies", { mods: "791:4.5.1", spt_version: "4.1.6" },
    ["## 791:4.5.1", "Version: 1.9.0", "Version: 1.5.0"]],
  ["resolve_mod_dependencies", { mods: "791:4.5.1", spt_version: "^4.1.0" }, ["VALIDATION_FAILED"], true],
  ["search_addons", { per_page: 3 }, ["Found", "Parent mod:"]],
  ["get_addon", { addon_id: 229 }, ["Parent mod:"]],
  ["get_addon_versions", { addon_id: 229, include: "virus_total_links" }, ["v1.0.1", "VirusTotal:"]],
  ["get_addon_file_tree", { addon_id: 229, version_id: 492 }, ["No verified file tree"]],
  ["resolve_addon_dependencies", { addons: "219:1.0.0,229:1.0.1", spt_version: "4.1.6" },
    ["Shared Hideout", "No dependencies."]],
  ["list_categories", {}, ["Bots"]],
  ["get_category", { identifier: "bots" }, ["Bots"]],
  ["get_spt_versions", { per_page: 5 }, ["SPT 4.1.6", "page 1 of"]],
];

// Output that means a formatter fell out of sync with the API.
const BAD_PATTERNS = [
  [/undefined/, "undefined"],
  [/\[object Object\]/, "[object Object]"],
  [/<\/?(p|div|span|a|ul|ol|li|strong|em|b|i|br|img|h[1-6]|code|pre|table|tr|td|blockquote)\b[^>]*>/i, "HTML tag"],
];

const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buffer = "";
let nextId = 0;

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});

function send(message) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), CALL_TIMEOUT_MS);
    pending.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    });
    send({ id, method, params });
  });
}

let failures = 0;
function report(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "spt-forge-smoke-test", version: "1.0.0" },
  });
  send({ method: "notifications/initialized" });

  const { tools } = await request("tools/list", {});
  const names = tools.map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n));
  report(!missing.length && !extra.length, `tools/list (${names.length} tools)`,
    [missing.length && `missing: ${missing}`, extra.length && `unexpected: ${extra}`].filter(Boolean).join("; "));

  const called = new Set();
  for (const [tool, args, mustContain, expectError = false] of CASES) {
    called.add(tool);
    const label = `${tool} ${JSON.stringify(args)}`;
    try {
      const result = await request("tools/call", { name: tool, arguments: args });
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      const problems = [];
      if (Boolean(result.isError) !== expectError) problems.push(`isError=${Boolean(result.isError)}`);
      for (const needle of mustContain) if (!text.includes(needle)) problems.push(`missing "${needle}"`);
      for (const [pattern, name] of BAD_PATTERNS) if (pattern.test(text)) problems.push(`contains ${name}`);
      report(!problems.length, label, problems.length ? `${problems.join(", ")}\n      ${text.slice(0, 300).replace(/\n/g, "\n      ")}` : "");
    } catch (err) {
      report(false, label, err.message);
    }
  }

  const uncovered = EXPECTED_TOOLS.filter((n) => !called.has(n));
  report(!uncovered.length, "every tool called", uncovered.length ? `not called: ${uncovered}` : "");
} catch (err) {
  report(false, "smoke test aborted", err.message);
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
