#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const VERSION = "1.1.0";
const DEFAULT_BASE_URL = "https://sp-mod.com/api/v0";
const BASE_URL = (process.env.FORGE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const USER_AGENT = `spt-forge-mcp/${VERSION}`;

const HEADERS = {
  Accept: "application/json",
  "User-Agent": USER_AGENT,
};

const MAX_RETRIES = 3;

class ForgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(message);
  }
}

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url.toString(), { headers: HEADERS });
    } catch (err: any) {
      const code = err?.cause?.code;
      const cause = typeof code === "string" ? code : err?.cause?.message ?? err?.message ?? String(err);
      throw new Error(
        `Could not reach the Forge API at ${BASE_URL} (${cause}). If the Forge has moved, set FORGE_API_BASE_URL.`
      );
    }

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error("Rate limited by Forge API after multiple retries.");
      }
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "30", 10);
      const delay = (Number.isFinite(retryAfter) ? retryAfter : 30) * 1000;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      let code: string | undefined;
      let message = body;
      try {
        const json = JSON.parse(body);
        code = json.code;
        message = json.message ?? body;
      } catch {
        // Not JSON (e.g. a CDN error page); keep the raw body.
      }
      throw new ForgeApiError(
        response.status,
        code,
        `Forge API error ${response.status}${code ? ` (${code})` : ""}: ${message}`
      );
    }

    return response.json();
  }

  throw new Error("Unreachable");
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

// The Forge returns descriptions as rendered HTML; turn them into compact plain text.
function htmlToText(html: string): string {
  let depth = 0; // list nesting; "\u0001" marks one indent level until whitespace is normalised
  return html
    .replace(/>\s*\n\s*</g, "><")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<a\b[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      return !text || text === href ? href : `${text} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(\/?)(ul|ol|li)\b[^>]*>/gi, (_, close: string, tag: string) => {
      if (tag.toLowerCase() === "li") return close ? "" : `\n${"\u0001".repeat(Math.max(depth - 1, 0))}- `;
      depth = Math.max(depth + (close ? -1 : 1), 0);
      return "\n";
    })
    .replace(/<hr\b[^>]*>/gi, "\n---\n")
    .replace(/<\/?(p|div|h[1-6]|blockquote|pre|table|tr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^(\u0001*-) *\n+/gm, "$1 ")
    .replace(/\n{2,}(?=\u0001*- )/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0001/g, "  ")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

// Version changelogs in list views: plain text, shortened, indented under the version.
function formatChangelog(html: string): string {
  const text = truncate(htmlToText(html), 500);
  return text ? `  Changelog:\n${text.split("\n").map((l) => (l ? `    ${l}` : "")).join("\n")}` : "";
}

// Sort comparator for version strings, newest first (stable releases before prereleases).
function compareVersionsDesc(a: string, b: string): number {
  const parse = (v: string) => {
    const dash = v.indexOf("-");
    const core = dash < 0 ? v : v.slice(0, dash);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: dash < 0 ? "" : v.slice(dash + 1) };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const diff = (pb.nums[i] ?? 0) - (pa.nums[i] ?? 0);
    if (diff) return diff;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return -1;
  if (!pb.pre) return 1;
  return pb.pre.localeCompare(pa.pre, undefined, { numeric: true });
}

// Each version dependency is a mod object whose `versions` are the versions satisfying the constraint.
function formatVersionDependency(dep: any): string {
  const versions = (dep.versions ?? []).map((v: any) => v.version).sort(compareVersionsDesc);
  const shown = versions.length
    ? `${versions.slice(0, 3).join(", ")}${versions.length > 3 ? ` (+${versions.length - 3} more)` : ""}`
    : "no matching published version";
  return `    - ${dep.name ?? dep.guid} (ID: ${dep.id}): ${shown}`;
}

function formatLinks(links: any[]): string {
  return links.map((l) => (l.label ? `${l.label} ${l.url}` : l.url)).join(", ");
}

// Notices the Forge shows on a mod's page.
function modWarnings(mod: any): string[] {
  return [
    mod.cheat_notice
      ? "⚠ Cheat notice: provides cheat-like functionality, designed for SPT only. Using it on live EFT servers will get you banned."
      : null,
    mod.shows_profile_binding_notice
      ? "⚠ Profile binding: may make permanent changes to your profile and may not be removable without starting a new profile."
      : null,
  ].filter((w): w is string => w !== null);
}

function formatModSummary(mod: any): string {
  const lines = [
    `**${mod.name}** (ID: ${mod.id})`,
    mod.teaser ? `  ${mod.teaser}` : null,
    ...modWarnings(mod).map((w) => `  ${w}`),
    `  Downloads: ${mod.downloads?.toLocaleString() ?? "N/A"}`,
    mod.endorsements_count != null ? `  Endorsements: ${mod.endorsements_count.toLocaleString()}` : null,
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
    ...modWarnings(mod).map((w) => `\n${w}`),
    mod.description ? `\n${htmlToText(mod.description)}` : null,
    `\nDownloads: ${mod.downloads?.toLocaleString() ?? "N/A"}`,
    mod.endorsements_count != null ? `Endorsements: ${mod.endorsements_count.toLocaleString()}` : null,
    mod.favourites_count != null ? `Favourites: ${mod.favourites_count.toLocaleString()}` : null,
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
    mod.category ? `Category: ${mod.category.title ?? mod.category.name}` : null,
    mod.license ? `License: ${mod.license.name}` : null,
    mod.detail_url ? `URL: ${mod.detail_url}` : null,
    mod.source_code_links?.length
      ? `Source: ${formatLinks(mod.source_code_links)}`
      : null,
    mod.published_at ? `Published: ${mod.published_at}` : null,
    mod.updated_at ? `Updated: ${mod.updated_at}` : null,
  ];

  if (mod.versions?.length) {
    lines.push("\n## Recent Versions");
    for (const v of mod.versions) {
      lines.push(
        `  ${v.version} (SPT ${v.spt_version_constraint || "?"}) — ${v.downloads?.toLocaleString() ?? 0} downloads${v.fika_compatibility ? ` [Fika: ${v.fika_compatibility}]` : ""}`
      );
    }
  }

  return lines.filter(Boolean).join("\n");
}

function formatAddonDetail(addon: any): string {
  const lines = [
    `# ${addon.name}`,
    addon.teaser ? `\n${addon.teaser}` : null,
    addon.description ? `\n${htmlToText(addon.description)}` : null,
    `\nDownloads: ${addon.downloads?.toLocaleString() ?? "N/A"}`,
    addon.owner ? `Author: ${addon.owner.name}` : null,
    addon.additional_authors?.length
      ? `Additional authors: ${addon.additional_authors.map((a: any) => a.name).join(", ")}`
      : null,
    addon.mod ? `Parent mod: ${addon.mod.name} (ID: ${addon.mod.id})` : null,
    addon.is_detached ? `Detached from parent mod${addon.detached_at ? ` since ${addon.detached_at}` : ""}` : null,
    addon.license ? `License: ${addon.license.name}` : null,
    addon.detail_url ? `URL: ${addon.detail_url}` : null,
    addon.source_code_links?.length
      ? `Source: ${formatLinks(addon.source_code_links)}`
      : null,
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

// Split an "identifier:version,identifier:version" list the way the Forge does.
function parsePairs(list: string): string[] {
  return [...new Set(list.split(",").map((p) => p.trim()).filter(Boolean))];
}

const BLOCK_REASONS: Record<string, string> = {
  dependency_constraint_violation: "another installed mod requires a different version",
  missing_dependency: "a dependency of the new version has no version for this SPT version",
  chain_dependency_conflict: "the new version's dependencies conflict with another installed mod",
};

function formatUpdates(data: any, requested: string): string {
  const sections: string[] = [`Target SPT version: ${data.spt_version}`];
  const matched: any[] = [];
  const label = (v: any) => `**${v.name ?? v.guid}** (ID: ${v.mod_id})`;

  if (data.updates?.length) {
    sections.push("## Updates Available\n" + data.updates.map((u: any) => {
      const cur = u.current_version;
      const rec = u.recommended_version;
      matched.push(cur);
      return [
        `- ${label(cur)}: ${cur.version} → ${rec.version}${u.update_reason === "newer_prerelease_available" ? " (prerelease)" : ""}`,
        rec.spt_versions?.length ? `  SPT: ${rec.spt_versions.join(", ")}` : null,
        rec.fika_compatibility ? `  Fika: ${rec.fika_compatibility}` : null,
        rec.link ? `  Download: ${rec.link}` : null,
      ].filter(Boolean).join("\n");
    }).join("\n"));
  }

  if (data.blocked_updates?.length) {
    sections.push("## Blocked Updates\n" + data.blocked_updates.map((u: any) => {
      const cur = u.current_version;
      matched.push(cur);
      const lines = [
        `- ${label(cur)}: ${cur.version} → ${u.latest_version.version} blocked: ${BLOCK_REASONS[u.block_reason] ?? u.block_reason}`,
      ];
      for (const b of u.blocking_mods ?? []) {
        lines.push(`  ${b.mod_name} ${b.current_version} (ID: ${b.mod_id}) requires ${b.constraint}`);
      }
      return lines.join("\n");
    }).join("\n"));
  }

  if (data.up_to_date?.length) {
    sections.push("## Up to Date\n" + data.up_to_date.map((u: any) => {
      matched.push(u);
      return `- ${label(u)}: ${u.version}${u.spt_versions?.length ? ` (SPT ${u.spt_versions.join(", ")})` : ""}`;
    }).join("\n"));
  }

  if (data.incompatible_with_spt?.length) {
    sections.push("## Incompatible with SPT\n" + data.incompatible_with_spt.map((u: any) => {
      matched.push(u);
      const reason = u.reason === "no_version_for_spt" ? `no version for SPT ${data.spt_version}` : u.reason;
      return `- ${label(u)}: ${u.version} (${reason})`;
    }).join("\n"));
  }

  const notFound = parsePairs(requested).filter((pair) => {
    const [id, version] = pair.split(":").map((s) => s.trim());
    return !matched.some(
      (m) => m.version === version && (String(m.mod_id) === id || m.guid?.toLowerCase() === id?.toLowerCase())
    );
  });
  if (notFound.length) {
    sections.push(`Not found on the Forge: ${notFound.join(", ")}`);
  }

  return sections.join("\n\n");
}

function formatDependencyTrees(data: any, requested: string, sptVersion: string): string {
  const sections: string[] = [];
  for (const [pair, nodes] of Object.entries<any[]>(data ?? {})) {
    const body = nodes.length
      ? nodes.map((d) => formatDep(d, 0, sptVersion)).join("\n")
      : "No dependencies.";
    sections.push(`## ${pair}\n${body}`);
  }
  const notFound = parsePairs(requested).filter((pair) => !(pair in (data ?? {})));
  if (notFound.length) {
    sections.push(`Not found on the Forge: ${notFound.join(", ")}`);
  }
  return sections.length ? sections.join("\n\n") : "No dependency information returned.";
}

function formatDep(dep: any, indent: number = 0, sptVersion?: string): string {
  const prefix = "  ".repeat(indent);
  const v = dep.latest_compatible_version;
  const lines = [
    `${prefix}${dep.name ?? dep.slug} (${dep.guid ?? dep.id})`,
    v ? `${prefix}  Version: ${v.version}` : `${prefix}  ⚠ No version compatible with SPT ${sptVersion ?? "?"}`,
    v?.link ? `${prefix}  Download: ${v.link}` : null,
    v?.fika_compatibility ? `${prefix}  Fika: ${v.fika_compatibility}` : null,
    dep.conflict ? `${prefix}  ⚠ VERSION CONFLICT` : null,
  ];
  if (dep.dependencies?.length) {
    for (const sub of dep.dependencies) {
      lines.push(formatDep(sub, indent + 1, sptVersion));
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
  version: VERSION,
});

// ─── search_mods ─────────────────────────────────────────────

server.registerTool(
  "search_mods",
  {
    title: "Search Mods",
    description:
      "Search and filter SPT mods on the Forge. Supports full-text search via `query`, filtering by name, category, SPT version, Fika compatibility, and more. Returns paginated results.",
    inputSchema: z.object({
      query: z
        .optional(z.string())
        .describe(
          "Full-text search across mod name, slug, and description (powered by Meilisearch)"
        ),
      filter_name: z
        .optional(z.string())
        .describe("Fuzzy filter by mod name"),
      filter_guid: z
        .optional(z.string())
        .describe("Exact mod GUID(s), comma-separated (e.g. 'me.sol.sain'). Useful to map a GUID to a mod ID"),
      filter_category_slug: z
        .optional(z.string())
        .describe(
          "Filter by category slug(s), comma-separated (e.g. 'weapons,gear')"
        ),
      filter_spt_version: z
        .optional(z.string())
        .describe(
          "Filter mods compatible with an SPT version constraint (e.g. '^4.1.0')"
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
          "Sort by field(s). Prefix with - for DESC. Options: name, downloads, favourites_count, endorsements_count, featured, created_at, updated_at, published_at. E.g. '-downloads'"
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
      "filter[guid]": input.filter_guid,
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
      "Get full details for a specific SPT mod by its numeric ID. Includes description, versions, license, and category by default.",
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
      filter_spt_version: z
        .optional(z.string())
        .describe("Only versions compatible with an SPT version or constraint (e.g. '4.1.6', '^4.1.0')"),
      filter_fika_compatibility: z
        .optional(z.string())
        .describe("Fika compatibility status(es), comma-separated: compatible, incompatible, unknown"),
      sort: z
        .optional(z.string())
        .describe(
          "Sort field(s), prefix with - for DESC. Options: version (semver), downloads, published_at, created_at, updated_at, id. Default '-published_at'"
        ),
      page: z.optional(z.number().int().min(1)),
      per_page: z.optional(z.number().int().min(1).max(50)),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      "filter[spt_version]": input.filter_spt_version,
      "filter[fika_compatibility]": input.filter_fika_compatibility,
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
        `  SPT: ${v.spt_version_constraint || "N/A"}`,
        `  Downloads: ${v.downloads?.toLocaleString() ?? 0}`,
        v.fika_compatibility
          ? `  Fika: ${v.fika_compatibility}`
          : null,
        v.content_length
          ? `  Size: ${(v.content_length / 1024 / 1024).toFixed(1)} MB`
          : null,
        v.published_at ? `  Published: ${v.published_at}` : null,
        v.link ? `  Download: ${v.link}` : null,
        v.virus_total_links?.length
          ? `  VirusTotal: ${formatLinks(v.virus_total_links)}`
          : null,
      ];
      if (v.dependencies?.length) {
        parts.push(`  Dependencies:\n${v.dependencies.map(formatVersionDependency).join("\n")}`);
      }
      if (v.description) parts.push(formatChangelog(v.description));
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
    return textResult(formatUpdates(data.data ?? data, input.mods));
  }
);

// ─── resolve_mod_dependencies ────────────────────────────────

server.registerTool(
  "resolve_mod_dependencies",
  {
    title: "Resolve Mod Dependencies",
    description:
      "Resolve the full recursive dependency tree for one or more mod versions against a specific SPT version. Returns one tree per requested pair, detects version conflicts and provides download links.",
    inputSchema: z.object({
      mods: z
        .string()
        .describe(
          "Comma-separated identifier:version pairs. Identifier can be mod ID or GUID. E.g. '5:1.2.0,com.example.mod:2.0.5'"
        ),
      spt_version: z
        .string()
        .describe(
          "SPT version to resolve dependency versions against. Must be an exact published SPT version (e.g. '4.1.6'), not a constraint"
        ),
    }),
  },
  async (input) => {
    const data = (await forgeGet("/mods/dependencies", {
      mods: input.mods,
      spt_version: input.spt_version,
    })) as any;

    return textResult(formatDependencyTrees(data.data, input.mods, input.spt_version));
  }
);

// ─── search_addons ───────────────────────────────────────────

server.registerTool(
  "search_addons",
  {
    title: "Search Addons",
    description:
      "Search SPT addons (supplemental content for mods, like music packs or texture overrides).",
    inputSchema: z.object({
      query: z.optional(z.string()).describe("Full-text search query"),
      filter_name: z.optional(z.string()).describe("Fuzzy filter by name"),
      filter_mod_id: z
        .optional(z.string())
        .describe("Filter by parent mod ID(s), comma-separated"),
      sort: z.optional(z.string()).describe("Sort field, e.g. '-published_at'"),
      include: z
        .optional(z.string())
        .describe("Relationships to include: mod (default), latest_version, versions, license, source_code_links"),
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
      include: input.include ?? "mod",
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
          a.mod
            ? `  Parent mod: ${a.mod.name} (ID: ${a.mod.id})`
            : a.mod_id ? `  Parent mod ID: ${a.mod_id}` : null,
          a.is_detached ? `  Detached from parent mod` : null,
          a.latest_version ? `  Latest version: ${a.latest_version.version}` : null,
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
        .describe("Relationships: versions, latest_version, license, mod, source_code_links"),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      include: input.include ?? "versions,license,mod,source_code_links",
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
      "List available SPT versions with mod counts and release links, newest first by default. Useful for determining which SPT version constraint to filter mods by.",
    inputSchema: z.object({
      filter_spt_version: z
        .optional(z.string())
        .describe("Only versions matching a semver constraint (e.g. '^4.1.0', '~3.11.0')"),
      sort: z
        .optional(z.string())
        .describe(
          "Sort field(s), prefix with - for DESC. Options: version (semver), mod_count, id, created_at, updated_at. Default '-version'"
        ),
      page: z.optional(z.number().int().min(1)),
      per_page: z.optional(z.number().int().min(1).max(50)),
    }),
  },
  async (input) => {
    const params: Record<string, string | undefined> = {
      "filter[spt_version]": input.filter_spt_version,
      sort: input.sort ?? "-version",
      page: input.page?.toString(),
      per_page: input.per_page?.toString(),
    };
    const data = (await forgeGet("/spt/versions", params)) as any;
    const versions = data.data ?? [];
    const meta = data.meta ?? {};

    const lines = versions.map(
      (v: any) =>
        `- **SPT ${v.version}** — ${v.mod_count} mods${v.link ? ` — [Release](${v.link})` : ""}`
    );
    const header = `${meta.total ?? versions.length} SPT versions (page ${meta.current_page ?? 1} of ${meta.last_page ?? 1})`;
    return textResult(`## SPT Versions\n\n${header}\n\n${lines.join("\n")}`);
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
    return textResult(data.data?.message ?? data.message ?? JSON.stringify(data));
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
        v.virus_total_links?.length
          ? `  VirusTotal: ${formatLinks(v.virus_total_links)}`
          : null,
        v.description ? formatChangelog(v.description) : null,
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
      "Resolve the full recursive mod dependency tree for one or more addon versions against a specific SPT version. Uses addon ID or slug as identifier (not GUID).",
    inputSchema: z.object({
      addons: z
        .string()
        .describe(
          "Comma-separated identifier:version pairs. Identifier is addon ID or slug. E.g. '12:1.0.0,my-addon:2.1.0'"
        ),
      spt_version: z
        .string()
        .describe(
          "SPT version to resolve dependency versions against. Must be an exact published SPT version (e.g. '4.1.6'), not a constraint"
        ),
    }),
  },
  async (input) => {
    const data = (await forgeGet("/addons/dependencies", {
      addons: input.addons,
      spt_version: input.spt_version,
    })) as any;

    return textResult(formatDependencyTrees(data.data, input.addons, input.spt_version));
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

// ─── get_mod_file_tree / get_addon_file_tree ────────────────

const MAX_FILE_TREE_LINES = 500;

function formatFileTree(tree: any): string {
  const files: string[] = tree.files ?? [];
  const lines = [
    `${tree.file_count ?? files.length} files${tree.verified_at ? ` (verified ${tree.verified_at})` : ""}`,
    tree.truncated ? "⚠ The archive has more files than the Forge records; this listing is incomplete." : null,
    "",
    ...files.slice(0, MAX_FILE_TREE_LINES),
    files.length > MAX_FILE_TREE_LINES ? `… ${files.length - MAX_FILE_TREE_LINES} more` : null,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

async function fileTreeResult(path: string) {
  try {
    const data = (await forgeGet(path)) as any;
    return textResult(formatFileTree(data.data));
  } catch (err) {
    if (err instanceof ForgeApiError && err.status === 404) {
      return textResult(
        "No verified file tree for this version yet: it hasn't passed the Forge's automated file verification, or the version doesn't exist or isn't public."
      );
    }
    throw err;
  }
}

const FILE_TREE_HINT =
  "Paths show where files install: client plugins under BepInEx/plugins, server mods under SPT_Runtime/user/mods (SPT 4.x) or user/mods (older SPT). Only available once the version has passed automated verification.";

server.registerTool(
  "get_mod_file_tree",
  {
    title: "Get Mod Version File Tree",
    description: `List the files inside a mod version's download archive, as recorded by the Forge's automated verification. ${FILE_TREE_HINT} Get version IDs from get_mod_versions.`,
    inputSchema: z.object({
      mod_id: z.number().int().describe("The mod's numeric ID"),
      version_id: z.number().int().describe("The mod version's numeric ID (not the version string)"),
    }),
  },
  async (input) => fileTreeResult(`/mod/${input.mod_id}/versions/${input.version_id}/file-tree`)
);

server.registerTool(
  "get_addon_file_tree",
  {
    title: "Get Addon Version File Tree",
    description: `List the files inside an addon version's download archive, as recorded by the Forge's automated verification. ${FILE_TREE_HINT} Get version IDs from get_addon_versions.`,
    inputSchema: z.object({
      addon_id: z.number().int().describe("The addon's numeric ID"),
      version_id: z.number().int().describe("The addon version's numeric ID (not the version string)"),
    }),
  },
  async (input) => fileTreeResult(`/addon/${input.addon_id}/versions/${input.version_id}/file-tree`)
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
