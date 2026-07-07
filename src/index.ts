#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const BASE_URL = "https://forge.sp-tarkov.com/api/v0";
const USER_AGENT = "spt-forge-mcp/1.0.0";

const HEADERS = {
  Accept: "application/json",
  "User-Agent": USER_AGENT,
};

async function forgeGet(
  path: string,
  params?: Record<string, string | undefined>
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  const response = await fetch(url.toString(), { headers: HEADERS });

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") ?? "unknown";
    throw new Error(
      `Rate limited by Forge API. Retry after ${retryAfter} seconds.`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Forge API error ${response.status}: ${body}`);
  }

  return response.json();
}

function formatModSummary(mod: any): string {
  const lines = [
    `**${mod.name}** (ID: ${mod.id})`,
    mod.teaser ? `  ${mod.teaser}` : null,
    `  Downloads: ${mod.downloads?.toLocaleString() ?? "N/A"}`,
    mod.owner ? `  Author: ${mod.owner.name}` : null,
    mod.fika_compatibility != null
      ? `  Fika compatible: ${mod.fika_compatibility}`
      : null,
    mod.featured ? `  Featured: yes` : null,
    mod.category ? `  Category: ${mod.category.title ?? mod.category.name}` : null,
    mod.detail_url ? `  URL: ${mod.detail_url}` : null,
    mod.guid ? `  GUID: ${mod.guid}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function formatModDetail(mod: any): string {
  const lines = [
    `# ${mod.name}`,
    mod.guid ? `GUID: ${mod.guid}` : null,
    mod.teaser ? `\n${mod.teaser}` : null,
    mod.description ? `\n${mod.description}` : null,
    `\nDownloads: ${mod.downloads?.toLocaleString() ?? "N/A"}`,
    mod.owner ? `Author: ${mod.owner.name}` : null,
    mod.additional_authors?.length
      ? `Additional authors: ${mod.additional_authors.map((a: any) => a.name).join(", ")}`
      : null,
    mod.fika_compatibility != null
      ? `Fika compatible: ${mod.fika_compatibility}`
      : null,
    mod.featured ? `Featured: yes` : null,
    mod.contains_ads ? `Contains ads: yes` : null,
    mod.contains_ai_content ? `Contains AI content: yes` : null,
    mod.category ? `Category: ${mod.category.name}` : null,
    mod.license ? `License: ${mod.license.name}` : null,
    mod.detail_url ? `URL: ${mod.detail_url}` : null,
    mod.source_code_links?.length
      ? `Source: ${mod.source_code_links.map((l: any) => l.url).join(", ")}`
      : null,
    mod.published_at ? `Published: ${mod.published_at}` : null,
    mod.updated_at ? `Updated: ${mod.updated_at}` : null,
  ];

  if (mod.versions?.length) {
    lines.push("\n## Recent Versions");
    for (const v of mod.versions) {
      lines.push(
        `  ${v.version} (SPT ${v.spt_version_constraint ?? "?"}) — ${v.downloads?.toLocaleString() ?? 0} downloads${v.fika_compatibility ? ` [Fika: ${v.fika_compatibility}]` : ""}`
      );
    }
  }

  return lines.filter(Boolean).join("\n");
}

function formatAddonDetail(addon: any): string {
  const lines = [
    `# ${addon.name}`,
    addon.teaser ? `\n${addon.teaser}` : null,
    addon.description ? `\n${addon.description}` : null,
    `\nDownloads: ${addon.downloads?.toLocaleString() ?? "N/A"}`,
    addon.owner ? `Author: ${addon.owner.name}` : null,
    addon.additional_authors?.length
      ? `Additional authors: ${addon.additional_authors.map((a: any) => a.name).join(", ")}`
      : null,
    addon.mod ? `Parent mod: ${addon.mod.name} (ID: ${addon.mod.id})` : null,
    addon.license ? `License: ${addon.license.name}` : null,
    addon.detail_url ? `URL: ${addon.detail_url}` : null,
    addon.contains_ads ? `Contains ads: yes` : null,
    addon.contains_ai_content ? `Contains AI content: yes` : null,
    addon.published_at ? `Published: ${addon.published_at}` : null,
    addon.updated_at ? `Updated: ${addon.updated_at}` : null,
  ];

  if (addon.versions?.length) {
    lines.push("\n## Recent Versions");
    for (const v of addon.versions) {
      lines.push(
        `  ${v.version}${v.mod_version_constraint ? ` (mod ${v.mod_version_constraint})` : ""} — ${v.downloads?.toLocaleString() ?? 0} downloads`
      );
    }
  }

  return lines.filter(Boolean).join("\n");
}

function formatUpdates(data: any): string {
  const sections: string[] = [];

  if (data.updates?.length) {
    sections.push("## Updates Available\n" + data.updates.map((u: any) =>
      `- **${u.name ?? u.identifier}**: ${u.current_version} → ${u.latest_version}${u.link ? ` — [Download](${u.link})` : ""}`
    ).join("\n"));
  }

  if (data.blocked_updates?.length) {
    sections.push("## Blocked Updates\n" + data.blocked_updates.map((u: any) =>
      `- **${u.name ?? u.identifier}**: ${u.current_version} → ${u.latest_version} (blocked: ${u.reason ?? "dependency conflict"})`
    ).join("\n"));
  }

  if (data.up_to_date?.length) {
    sections.push("## Up to Date\n" + data.up_to_date.map((u: any) =>
      `- **${u.name ?? u.identifier}**: ${u.current_version}`
    ).join("\n"));
  }

  if (data.incompatible_with_spt?.length) {
    sections.push("## Incompatible with SPT\n" + data.incompatible_with_spt.map((u: any) =>
      `- **${u.name ?? u.identifier}**: ${u.current_version}`
    ).join("\n"));
  }

  return sections.length ? sections.join("\n\n") : "No update information returned.";
}

function formatDep(dep: any, indent: number = 0): string {
  const prefix = "  ".repeat(indent);
  const v = dep.latest_compatible_version;
  const lines = [
    `${prefix}${dep.name ?? dep.slug} (${dep.guid ?? dep.id})`,
    v ? `${prefix}  Version: ${v.version}` : null,
    v?.link ? `${prefix}  Download: ${v.link}` : null,
    v?.fika_compatibility ? `${prefix}  Fika: ${v.fika_compatibility}` : null,
    dep.conflict ? `${prefix}  ⚠ VERSION CONFLICT` : null,
  ];
  if (dep.dependencies?.length) {
    for (const sub of dep.dependencies) {
      lines.push(formatDep(sub, indent + 1));
    }
  }
  return lines.filter(Boolean).join("\n");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ─── Server setup ────────────────────────────────────────────

const server = new McpServer({
  name: "spt-forge",
  version: "1.0.0",
});

// ─── search_mods ─────────────────────────────────────────────

server.registerTool(
  "search_mods",
  {
    title: "Search Mods",
    description:
      "Search and filter SP-Tarkov mods on the Forge. Supports full-text search via `query`, filtering by name, category, SPT version, Fika compatibility, and more. Returns paginated results.",
    inputSchema: z.object({
      query: z
        .optional(z.string())
        .describe(
          "Full-text search across mod name, slug, and description (powered by Meilisearch)"
        ),
      filter_name: z
        .optional(z.string())
        .describe("Fuzzy filter by mod name"),
      filter_category_slug: z
        .optional(z.string())
        .describe(
          "Filter by category slug(s), comma-separated (e.g. 'weapons,gear')"
        ),
      filter_spt_version: z
        .optional(z.string())
        .describe(
          "Filter mods compatible with an SPT version constraint (e.g. '^3.11.0')"
        ),
      filter_fika_compatible: z
        .optional(z.boolean())
        .describe("Filter to only Fika-compatible mods"),
      filter_featured: z
        .optional(z.boolean())
        .describe("Filter to featured mods only"),
      sort: z
        .optional(z.string())
        .describe(
          "Sort by field(s). Prefix with - for DESC. Options: name, featured, created_at, updated_at, published_at. E.g. '-published_at'"
        ),
      include: z
        .optional(z.string())
        .describe(
          "Comma-separated relationships to include: versions, license, category, source_code_links"
        ),
      page: z.optional(z.number().int().min(1)).describe("Page number"),
      per_page: z
        .optional(z.number().int().min(1).max(50))
        .describe("Results per page (max 50)"),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      query: input.query,
      "filter[name]": input.filter_name,
      "filter[category_slug]": input.filter_category_slug,
      "filter[spt_version]": input.filter_spt_version,
      "filter[fika_compatibility]": input.filter_fika_compatible?.toString(),
      "filter[featured]": input.filter_featured?.toString(),
      sort: input.sort,
      include: input.include ?? "category",
      page: input.page?.toString(),
      per_page: input.per_page?.toString(),
    };

    const data = (await forgeGet("/mods", params)) as any;
    const mods = data.data ?? [];
    const meta = data.meta ?? {};

    const header = `Found ${meta.total ?? mods.length} mods (page ${meta.current_page ?? 1} of ${meta.last_page ?? 1})`;
    const modList = mods.map(formatModSummary).join("\n\n");

    return textResult(`${header}\n\n${modList}`);
  }
);

// ─── get_mod ─────────────────────────────────────────────────

server.registerTool(
  "get_mod",
  {
    title: "Get Mod Details",
    description:
      "Get full details for a specific SP-Tarkov mod by its numeric ID. Includes description, versions, license, and category by default.",
    inputSchema: z.object({
      mod_id: z.number().int().describe("The mod's numeric ID"),
      include: z
        .optional(z.string())
        .describe(
          "Comma-separated relationships: versions, license, category, source_code_links"
        ),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      include: input.include ?? "versions,license,category,source_code_links",
    };
    const data = (await forgeGet(`/mod/${input.mod_id}`, params)) as any;
    return textResult(formatModDetail(data.data));
  }
);

// ─── get_mod_versions ────────────────────────────────────────

server.registerTool(
  "get_mod_versions",
  {
    title: "Get Mod Versions",
    description:
      "Get the full version history for a mod. Includes SPT version constraints, download counts, Fika compatibility status, and dependency info.",
    inputSchema: z.object({
      mod_id: z.number().int().describe("The mod's numeric ID"),
      include: z
        .optional(z.string())
        .describe(
          "Comma-separated relationships to include: dependencies, virus_total_links"
        ),
      sort: z
        .optional(z.string())
        .describe("Sort field, e.g. '-published_at' for newest first"),
      page: z.optional(z.number().int().min(1)),
      per_page: z.optional(z.number().int().min(1).max(50)),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      include: input.include ?? "dependencies",
      sort: input.sort ?? "-published_at",
      page: input.page?.toString(),
      per_page: input.per_page?.toString(),
    };
    const data = (await forgeGet(
      `/mod/${input.mod_id}/versions`,
      params
    )) as any;
    const versions = data.data ?? [];
    const meta = data.meta ?? {};

    const lines = versions.map((v: any) => {
      const parts = [
        `**v${v.version}** (ID: ${v.id})`,
        `  SPT: ${v.spt_version_constraint ?? "N/A"}`,
        `  Downloads: ${v.downloads?.toLocaleString() ?? 0}`,
        v.fika_compatibility
          ? `  Fika: ${v.fika_compatibility}`
          : null,
        v.content_length
          ? `  Size: ${(v.content_length / 1024 / 1024).toFixed(1)} MB`
          : null,
        v.published_at ? `  Published: ${v.published_at}` : null,
        v.link ? `  Download: ${v.link}` : null,
      ];
      if (v.dependencies?.length) {
        parts.push(
          `  Dependencies: ${v.dependencies.map((d: any) => `${d.name ?? d.guid} (${d.version_constraint ?? "any"})`).join(", ")}`
        );
      }
      return parts.filter(Boolean).join("\n");
    });

    const header = `${versions.length} versions (page ${meta.current_page ?? 1} of ${meta.last_page ?? 1})`;
    return textResult(`${header}\n\n${lines.join("\n\n")}`);
  }
);

// ─── check_mod_updates ───────────────────────────────────────

server.registerTool(
  "check_mod_updates",
  {
    title: "Check Mod Updates",
    description:
      "Check for available updates for installed mods against a target SPT version. Handles dependency validation and prerelease logic.",
    inputSchema: z.object({
      mods: z
        .string()
        .describe(
          "Comma-separated identifier:version pairs. Identifier can be mod ID or GUID. E.g. '5:1.2.0,com.example.mod:2.0.5'"
        ),
      spt_version: z
        .string()
        .describe("Target SPT version to check compatibility against"),
    }),
  },
  async (input) => {
    const params = { mods: input.mods, spt_version: input.spt_version };
    const data = (await forgeGet("/mods/updates", params)) as any;
    return textResult(formatUpdates(data.data ?? data));
  }
);

// ─── resolve_mod_dependencies ────────────────────────────────

server.registerTool(
  "resolve_mod_dependencies",
  {
    title: "Resolve Mod Dependencies",
    description:
      "Resolve the full recursive dependency tree for one or more mod versions. Detects version conflicts and provides download links.",
    inputSchema: z.object({
      mods: z
        .string()
        .describe(
          "Comma-separated identifier:version pairs. E.g. '5:1.2.0,com.example.mod:2.0.5'"
        ),
    }),
  },
  async (input) => {
    const data = (await forgeGet("/mods/dependencies", {
      mods: input.mods,
    })) as any;

    const deps = data.data ?? [];
    if (!deps.length) return textResult("No dependencies found.");
    return textResult(deps.map((d: any) => formatDep(d)).join("\n\n"));
  }
);

// ─── search_addons ───────────────────────────────────────────

server.registerTool(
  "search_addons",
  {
    title: "Search Addons",
    description:
      "Search SP-Tarkov addons (supplemental content for mods, like music packs or texture overrides).",
    inputSchema: z.object({
      query: z.optional(z.string()).describe("Full-text search query"),
      filter_name: z.optional(z.string()).describe("Fuzzy filter by name"),
      filter_mod_id: z
        .optional(z.string())
        .describe("Filter by parent mod ID(s), comma-separated"),
      sort: z.optional(z.string()).describe("Sort field, e.g. '-published_at'"),
      include: z
        .optional(z.string())
        .describe("Relationships to include: versions, license, mod"),
      page: z.optional(z.number().int().min(1)),
      per_page: z.optional(z.number().int().min(1).max(50)),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      query: input.query,
      "filter[name]": input.filter_name,
      "filter[mod_id]": input.filter_mod_id,
      sort: input.sort,
      include: input.include,
      page: input.page?.toString(),
      per_page: input.per_page?.toString(),
    };
    const data = (await forgeGet("/addons", params)) as any;
    const addons = data.data ?? [];
    const meta = data.meta ?? {};

    const header = `Found ${meta.total ?? addons.length} addons (page ${meta.current_page ?? 1} of ${meta.last_page ?? 1})`;
    const list = addons
      .map((a: any) => {
        return [
          `**${a.name}** (ID: ${a.id})`,
          a.teaser ? `  ${a.teaser}` : null,
          `  Downloads: ${a.downloads?.toLocaleString() ?? "N/A"}`,
          a.owner ? `  Author: ${a.owner.name}` : null,
          a.detail_url ? `  URL: ${a.detail_url}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    return textResult(`${header}\n\n${list}`);
  }
);

// ─── get_addon ───────────────────────────────────────────────

server.registerTool(
  "get_addon",
  {
    title: "Get Addon Details",
    description: "Get full details for a specific addon by its numeric ID.",
    inputSchema: z.object({
      addon_id: z.number().int().describe("The addon's numeric ID"),
      include: z
        .optional(z.string())
        .describe("Relationships: versions, license, mod"),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      include: input.include ?? "versions,license,mod",
    };
    const data = (await forgeGet(`/addon/${input.addon_id}`, params)) as any;
    return textResult(formatAddonDetail(data.data));
  }
);

// ─── list_categories ─────────────────────────────────────────

server.registerTool(
  "list_categories",
  {
    title: "List Mod Categories",
    description:
      "List all available mod categories on the Forge. Useful for discovering category slugs to filter searches.",
    inputSchema: z.object({}),
  },
  async () => {
    const data = (await forgeGet("/mod-categories")) as any;
    const cats = data.data ?? [];

    const lines = cats.map(
      (c: any) => `- **${c.title}** (slug: \`${c.slug}\`, id: ${c.id})`
    );
    return textResult(`## Mod Categories\n\n${lines.join("\n")}`);
  }
);

// ─── get_spt_versions ────────────────────────────────────────

server.registerTool(
  "get_spt_versions",
  {
    title: "Get SPT Versions",
    description:
      "List available SPT versions with mod counts and release links. Useful for determining which SPT version constraint to filter mods by.",
    inputSchema: z.object({
      page: z.optional(z.number().int().min(1)),
      per_page: z.optional(z.number().int().min(1).max(50)),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      page: input.page?.toString(),
      per_page: input.per_page?.toString(),
    };
    const data = (await forgeGet("/spt/versions", params)) as any;
    const versions = data.data ?? [];

    const lines = versions.map(
      (v: any) =>
        `- **SPT ${v.version}** — ${v.mod_count} mods${v.link ? ` — [Release](${v.link})` : ""}`
    );
    return textResult(`## SPT Versions\n\n${lines.join("\n")}`);
  }
);

// ─── ping ───────────────────────────────────────────────────

server.registerTool(
  "ping",
  {
    title: "Ping Forge API",
    description: "Health check — returns pong if the Forge API is reachable.",
    inputSchema: z.object({}),
  },
  async () => {
    const data = (await forgeGet("/ping")) as any;
    return textResult(data.message ?? JSON.stringify(data));
  }
);

// ─── get_addon_versions ─────────────────────────────────────

server.registerTool(
  "get_addon_versions",
  {
    title: "Get Addon Versions",
    description:
      "Get the full version history for an addon. Includes mod version constraints, download counts, and file sizes.",
    inputSchema: z.object({
      addon_id: z.number().int().describe("The addon's numeric ID"),
      include: z
        .optional(z.string())
        .describe("Relationships to include: virus_total_links"),
      sort: z
        .optional(z.string())
        .describe("Sort field, e.g. '-published_at' for newest first"),
      page: z.optional(z.number().int().min(1)),
      per_page: z.optional(z.number().int().min(1).max(50)),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      include: input.include,
      sort: input.sort ?? "-published_at",
      page: input.page?.toString(),
      per_page: input.per_page?.toString(),
    };
    const data = (await forgeGet(
      `/addon/${input.addon_id}/versions`,
      params
    )) as any;
    const versions = data.data ?? [];
    const meta = data.meta ?? {};

    const lines = versions.map((v: any) => {
      const parts = [
        `**v${v.version}** (ID: ${v.id})`,
        v.mod_version_constraint
          ? `  Mod version: ${v.mod_version_constraint}`
          : null,
        `  Downloads: ${v.downloads?.toLocaleString() ?? 0}`,
        v.content_length
          ? `  Size: ${(v.content_length / 1024 / 1024).toFixed(1)} MB`
          : null,
        v.published_at ? `  Published: ${v.published_at}` : null,
        v.link ? `  Download: ${v.link}` : null,
        v.description ? `  ${v.description}` : null,
      ];
      return parts.filter(Boolean).join("\n");
    });

    const header = `${versions.length} addon versions (page ${meta.current_page ?? 1} of ${meta.last_page ?? 1})`;
    return textResult(`${header}\n\n${lines.join("\n\n")}`);
  }
);

// ─── resolve_addon_dependencies ─────────────────────────────

server.registerTool(
  "resolve_addon_dependencies",
  {
    title: "Resolve Addon Dependencies",
    description:
      "Resolve the full recursive dependency tree for one or more addon versions. Uses addon ID or slug as identifier (not GUID).",
    inputSchema: z.object({
      addons: z
        .string()
        .describe(
          "Comma-separated identifier:version pairs. Identifier is addon ID or slug. E.g. '12:1.0.0,my-addon:2.1.0'"
        ),
    }),
  },
  async (input) => {
    const data = (await forgeGet("/addons/dependencies", {
      addons: input.addons,
    })) as any;

    const deps = data.data ?? [];
    if (!deps.length) return textResult("No dependencies found.");
    return textResult(deps.map((d: any) => formatDep(d)).join("\n\n"));
  }
);

// ─── get_category ───────────────────────────────────────────

server.registerTool(
  "get_category",
  {
    title: "Get Category",
    description:
      "Get a single mod category by its numeric ID or slug.",
    inputSchema: z.object({
      identifier: z
        .string()
        .describe("Category ID (numeric) or slug string"),
    }),
  },
  async (input) => {
    const data = (await forgeGet(
      `/mod-categories/${input.identifier}`
    )) as any;
    const cat = data.data ?? data;
    return textResult(
      `**${cat.title}** (slug: \`${cat.slug}\`, id: ${cat.id})${cat.description ? `\n${cat.description}` : ""}`
    );
  }
);

// ─── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SPT Forge MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
