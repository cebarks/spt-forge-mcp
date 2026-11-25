# spt-forge-mcp

MCP server for the [SPT Forge API](https://sp-mod.com/docs/). Exposes Forge endpoints as MCP tools over stdio, letting LLMs search mods, check updates, resolve dependencies, browse addons, inspect release file trees, and list SPT versions.

> **Domain change:** the SPT project (now *Single Player Tushonka*) retired `sp-tarkov.com` in 2026. The Forge moved to `https://sp-mod.com` (`forge.sp-mod.com` redirects there), and this server now uses `https://sp-mod.com/api/v0` by default. If the Forge moves again, point the server at the new address with `FORGE_API_BASE_URL` (see below) instead of waiting for a release.

## Setup

```bash
npm install
npm run build
```

### Claude Code

Add to your MCP config (`.claude/settings.json` or global settings):

```json
{
  "mcpServers": {
    "spt-forge": {
      "command": "node",
      "args": ["/path/to/spt-forge-mcp/dist/index.js"]
    }
  }
}
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGE_API_BASE_URL` | `https://sp-mod.com/api/v0` | Base URL of the Forge API (including `/api/v0`). |

```json
{
  "mcpServers": {
    "spt-forge": {
      "command": "node",
      "args": ["/path/to/spt-forge-mcp/dist/index.js"],
      "env": { "FORGE_API_BASE_URL": "https://sp-mod.com/api/v0" }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `search_mods` | Full-text search and filter mods (name, GUID, category, SPT version, Fika compatibility); sort by downloads, endorsements, etc. |
| `get_mod` | Get full details for a mod by ID, including cheat / profile-binding notices |
| `get_mod_versions` | Paginated version history with changelogs, dependencies and VirusTotal links; filter by SPT version or Fika compatibility |
| `get_mod_file_tree` | Files inside a mod version's archive (`mod_id`, `version_id`), once verified by the Forge |
| `check_mod_updates` | Check for updates given installed `mods` (`id:version` or `guid:version`) and a target `spt_version` |
| `resolve_mod_dependencies` | Recursive dependency tree per mod version for a given `spt_version` (required), with conflict detection |
| `search_addons` | Search addons (supplemental mod content), showing the parent mod |
| `get_addon` | Get full addon details by ID |
| `get_addon_versions` | Paginated addon version history with changelogs and VirusTotal links |
| `get_addon_file_tree` | Files inside an addon version's archive (`addon_id`, `version_id`), once verified by the Forge |
| `resolve_addon_dependencies` | Recursive mod dependency tree per addon version for a given `spt_version` (required) |
| `list_categories` | List all mod categories |
| `get_category` | Get a single category by ID or slug |
| `get_spt_versions` | List SPT versions with mod counts, newest first; filter by semver constraint |
| `ping` | Forge API health check |

`spt_version` for `check_mod_updates` and the dependency tools must be an exact, published SPT version (e.g. `4.1.6`); use `get_spt_versions` to find one. Full API reference: <https://sp-mod.com/docs/>.
