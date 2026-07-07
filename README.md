# spt-forge-mcp

MCP server for the [SP-Tarkov Forge API](https://forge.sp-tarkov.com). Exposes Forge endpoints as MCP tools over stdio, letting LLMs search mods, check updates, resolve dependencies, browse addons, and list SPT versions.

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

## Tools

| Tool | Description |
|------|-------------|
| `search_mods` | Full-text search and filter mods (name, category, SPT version, Fika compatibility) |
| `get_mod` | Get full details for a mod by ID |
| `get_mod_versions` | Paginated version history with dependencies |
| `check_mod_updates` | Check for updates given installed mod versions and target SPT version |
| `resolve_mod_dependencies` | Recursive dependency tree with conflict detection |
| `search_addons` | Search addons (supplemental mod content) |
| `get_addon` | Get full addon details by ID |
| `get_addon_versions` | Paginated addon version history |
| `resolve_addon_dependencies` | Recursive addon dependency tree |
| `list_categories` | List all mod categories |
| `get_category` | Get a single category by ID or slug |
| `get_spt_versions` | List SPT versions with mod counts |
| `ping` | Forge API health check |

