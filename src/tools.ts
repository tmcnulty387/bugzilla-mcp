import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BugzillaClient, BugzillaError, type Bug, type QueryParams } from "./bugzilla.js";
import {
  DETAIL_FIELDS,
  SUMMARY_FIELDS,
  bugIdFromSeeAlso,
  formatAttachment,
  formatBug,
  formatComment,
  formatProduct,
} from "./format.js";

const MAX_SEARCH_LIMIT = 500;
const MAX_BATCH_IDS = 200;

const idOrAlias = z.union([z.number().int().positive(), z.string().min(1)]);

const stringList = z.array(z.string().min(1)).min(1);

const ADVANCED_OPERATORS = [
  "equals",
  "notequals",
  "anyexact",
  "substring",
  "casesubstring",
  "notsubstring",
  "anywordssubstr",
  "allwordssubstr",
  "nowordssubstr",
  "regexp",
  "notregexp",
  "lessthan",
  "lessthaneq",
  "greaterthan",
  "greatertheq",
  "anywords",
  "allwords",
  "nowords",
  "changedbefore",
  "changedafter",
  "changedfrom",
  "changedto",
  "changedby",
  "isempty",
  "isnotempty",
] as const;

const RELATIVE_TIME = /^([+-]?)(\d+)\s*([hdwmy])$/i;
const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  m: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

/**
 * Bugzilla's REST time parameters (creation_time, last_change_time, new_since) only accept
 * absolute dates, so convert relative shorthand like `-7d` / `2w` into an ISO timestamp.
 */
export function resolveTime(value: string | undefined, now: Date = new Date()): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const match = RELATIVE_TIME.exec(trimmed);
  if (!match) return trimmed;
  const amount = Number(match[2]);
  const unit = match[3]!.toLowerCase();
  const ms = amount * UNIT_MS[unit]!;
  // Both `-7d` and `7d` mean "7 days ago"; only an explicit `+` means the future.
  const sign = match[1] === "+" ? 1 : -1;
  return new Date(now.getTime() + sign * ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Bugzilla's internal field names differ from the ones shown in the UI and REST bug objects. */
const FIELD_ALIASES: Record<string, string> = {
  status: "bug_status",
  severity: "bug_severity",
  platform: "rep_platform",
  type: "bug_type",
  milestone: "target_milestone",
  summary: "short_desc",
  whiteboard: "status_whiteboard",
  creator: "reporter",
  os: "op_sys",
  id: "bug_id",
};

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof BugzillaError) {
    const parts = [err.message];
    if (err.code !== undefined) parts.push(`(Bugzilla error code ${err.code})`);
    if (err.httpStatus === 401 || err.code === 410 || err.code === 306) {
      parts.push("This request requires authentication. Set the BUGZILLA_API_KEY environment variable.");
    }
    message = parts.join(" ");
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchBugsBatched(client: BugzillaClient, ids: Array<number | string>, fields: string[]): Promise<Bug[]> {
  const results: Bug[] = [];
  for (const group of chunk(ids, MAX_BATCH_IDS)) {
    const { bugs } = await client.getBugs(group, fields);
    results.push(...bugs);
  }
  return results;
}

export function registerTools(server: McpServer, client: BugzillaClient): void {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  // ---------------------------------------------------------------------------
  server.registerTool(
    "search_bugs",
    {
      title: "Search Bugzilla bugs",
      description: [
        "Search bugzilla.mozilla.org for bugs. Combine free-text `quicksearch` with structured filters.",
        "",
        "Quicksearch syntax highlights (https://bugzilla.mozilla.org/page.cgi?id=quicksearch.html):",
        "- Plain words search summary/comments/whiteboard; a leading `ALL` includes closed bugs, otherwise only open bugs are matched.",
        "- Prefix shortcuts: `product:Firefox`, `component:\"Address Bar\"`, `status:NEW`, `assignee:someone@mozilla.com`, `keyword:crash`, `whiteboard:[foo]`, `flag:needinfo?`, `P1`, `S2`, `regression`.",
        "- A bare bug number returns that bug.",
        "",
        "Structured filters (product/component/status/...) apply to all bugs regardless of open/closed unless `status` is given.",
        "`status` accepts real statuses (UNCONFIRMED, NEW, ASSIGNED, REOPENED, RESOLVED, VERIFIED, CLOSED) or the pseudo-values `__open__` / `__closed__` / `__all__`.",
        "Time filters accept ISO timestamps (`2024-01-01T00:00:00Z`), dates (`2024-01-01`) or relative values like `-7d`, `-2w`, `-1m`, `-1y`.",
        "Use `advanced_filters` for anything not covered (e.g. `{field: \"cf_crash_signature\", operator: \"substring\", value: \"nsThread\"}`, `{field: \"flagtypes.name\", operator: \"substring\", value: \"needinfo?\"}`, `{field: \"delta_ts\", operator: \"changedafter\", value: \"-7d\"}`). Full-text comment searches (`longdesc`) are slow on bugzilla.mozilla.org; always narrow them with product/status filters.",
        "Set `count_only` to get just the number of matching bugs.",
      ].join("\n"),
      inputSchema: {
        quicksearch: z.string().min(1).optional().describe("Free-text quicksearch query, e.g. 'ALL crash on startup product:Firefox'"),
        product: stringList.optional().describe("Product name(s), e.g. ['Firefox', 'Core', 'Toolkit', 'DevTools', 'Fenix']"),
        component: stringList.optional().describe("Component name(s), e.g. ['Address Bar']"),
        status: stringList.optional().describe("Status value(s) or __open__ / __closed__ / __all__"),
        resolution: stringList.optional().describe("Resolution(s), e.g. ['FIXED'], ['---'] for unresolved"),
        type: z.array(z.enum(["defect", "enhancement", "task"])).optional().describe("Bug type(s)"),
        priority: stringList.optional().describe("Priority value(s): P1..P5 or '--'"),
        severity: stringList.optional().describe("Severity value(s): S1..S4, N/A, or '--'"),
        keywords: stringList.optional().describe("Keyword(s) the bug must have, e.g. ['regression', 'crash', 'good-first-bug']"),
        whiteboard: z.string().optional().describe("Substring that must appear in the status whiteboard"),
        summary: z.string().optional().describe("Substring that must appear in the summary (case-insensitive)"),
        assigned_to: z.string().optional().describe("Assignee email/login; use 'nobody@mozilla.org' for unassigned"),
        creator: z.string().optional().describe("Reporter email/login"),
        target_milestone: stringList.optional(),
        version: stringList.optional(),
        platform: stringList.optional(),
        op_sys: stringList.optional(),
        creation_time: z.string().optional().describe("Only bugs created at/after this time (ISO date/time or relative like -30d)"),
        last_change_time: z.string().optional().describe("Only bugs changed at/after this time (ISO date/time or relative like -7d)"),
        advanced_filters: z
          .array(
            z.object({
              field: z.string().min(1).describe("Bug field name, e.g. longdesc, cf_crash_signature, flagtypes.name, cc, commenter, keywords, dependson, blocked, regressed_by, see_also, attachments.mimetype"),
              operator: z.enum(ADVANCED_OPERATORS),
              value: z.string().default("").describe("Comparison value; may be empty for isempty/isnotempty"),
            }),
          )
          .max(20)
          .optional()
          .describe("Bugzilla boolean-chart filters (f1/o1/v1). All filters are AND-ed."),
        additional_params: z
          .record(z.string(), z.string())
          .optional()
          .describe("Escape hatch: raw query parameters passed straight to /rest/bug (e.g. {\"cf_fx_points\": \"3\"})"),
        order: z
          .string()
          .optional()
          .describe("Sort order, comma-separated field names with optional DESC, e.g. 'changeddate DESC' or 'priority,bug_id'. Bugzilla defaults to relevance/id."),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(25).describe("Maximum bugs to return (default 25)"),
        offset: z.number().int().min(0).default(0).describe("Skip this many results (for paging)"),
        include_fields: z
          .array(z.string())
          .optional()
          .describe("Bug fields to return. Defaults to a compact summary set. Use ['_default'] for Bugzilla's default field set or ['_all'] for everything."),
        count_only: z.boolean().default(false).describe("Return only the count of matching bugs"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const params: QueryParams = {
          quicksearch: args.quicksearch,
          product: args.product,
          component: args.component,
          resolution: args.resolution,
          type: args.type,
          priority: args.priority,
          severity: args.severity,
          keywords: args.keywords,
          whiteboard: args.whiteboard,
          summary: args.summary,
          assigned_to: args.assigned_to,
          creator: args.creator,
          target_milestone: args.target_milestone,
          version: args.version,
          platform: args.platform,
          op_sys: args.op_sys,
          creation_time: resolveTime(args.creation_time),
          last_change_time: resolveTime(args.last_change_time),
          order: args.order,
          limit: args.limit,
          offset: args.offset > 0 ? args.offset : undefined,
        };

        if (args.status) {
          // `__all__` is our own pseudo-value meaning "don't filter on status".
          const statuses = args.status.filter((s) => s !== "__all__");
          if (statuses.length > 0) params.status = statuses;
        }

        if (args.keywords) {
          // Require every keyword to be present (Bugzilla's default `keywords` param matches any).
          params.keywords_type = "allwords";
        }

        if (args.advanced_filters) {
          args.advanced_filters.forEach((filter, i) => {
            const n = i + 1;
            params[`f${n}`] = filter.field;
            params[`o${n}`] = filter.operator;
            params[`v${n}`] = filter.value;
          });
        }

        if (args.additional_params) Object.assign(params, args.additional_params);

        if (args.count_only) {
          params.count_only = 1;
          delete params.limit;
          delete params.offset;
          const result = await client.searchBugs(params);
          const count = (result as unknown as { bug_count?: number }).bug_count;
          return json({ bug_count: count ?? result.bugs?.length ?? 0 });
        }

        params.include_fields = (args.include_fields ?? SUMMARY_FIELDS).join(",");
        const { bugs } = await client.searchBugs(params);
        return json({
          count: bugs.length,
          offset: args.offset,
          limit: args.limit,
          has_more: bugs.length >= args.limit,
          bugs: bugs.map((b) => formatBug(b, client)),
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_bug",
    {
      title: "Get bug details",
      description:
        "Fetch one or more bugs by ID or alias with full metadata (status, resolution, product/component, assignee, dependencies, regressions, duplicates, flags, see-also links, keywords, whiteboard, timestamps). Does not include comments; use get_bug_comments for those.",
      inputSchema: {
        ids: z.array(idOrAlias).min(1).max(MAX_BATCH_IDS).describe("Bug IDs or aliases"),
        include_fields: z
          .array(z.string())
          .optional()
          .describe("Override the returned fields. Use ['_all'] for every field including custom cf_* fields. The CC list is only included when 'cc' or '_all' is requested explicitly (cc_count is always present)."),
      },
      annotations: readOnly,
    },
    async ({ ids, include_fields }) =>
      run(async () => {
        const fields = include_fields ?? DETAIL_FIELDS;
        const includeCc = include_fields?.some((f) => f === "cc" || f === "_all") ?? false;
        const bugs = await fetchBugsBatched(client, ids, fields);
        const found = new Set(bugs.map((b) => b.id));
        const foundAliases = new Set(bugs.flatMap((b) => (Array.isArray(b.alias) ? b.alias : b.alias ? [b.alias] : [])));
        const missing = ids.filter((id) => (typeof id === "number" ? !found.has(id) : !foundAliases.has(id) && !found.has(Number(id))));
        return json({
          bugs: bugs.map((b) => formatBug(b, client, { includeCc })),
          ...(missing.length > 0 ? { not_found: missing } : {}),
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_bug_comments",
    {
      title: "Get bug comments",
      description:
        "Fetch the comment thread for a bug. Comment #0 is the original description. Supports paging, newest-first ordering, filtering by time, and truncating long comments.",
      inputSchema: {
        bug_id: idOrAlias.describe("Bug ID or alias"),
        new_since: z.string().optional().describe("Only comments created at/after this time (ISO timestamp or relative like -7d)"),
        order: z.enum(["oldest_first", "newest_first"]).default("oldest_first"),
        offset: z.number().int().min(0).default(0).describe("Skip this many comments (after ordering)"),
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum comments to return"),
        max_chars_per_comment: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Truncate each comment's text to this many characters"),
        include_description: z.boolean().default(true).describe("Include comment #0 (the bug description)"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        let comments = await client.getComments(args.bug_id, resolveTime(args.new_since));
        if (!args.include_description) comments = comments.filter((c) => c.count !== 0);
        if (args.order === "newest_first") comments = [...comments].reverse();
        const total = comments.length;
        const page = comments.slice(args.offset, args.offset + args.limit);
        return json({
          bug_id: args.bug_id,
          url: client.bugUrl(args.bug_id),
          total_comments: total,
          returned: page.length,
          offset: args.offset,
          has_more: args.offset + page.length < total,
          comments: page.map((c) =>
            formatComment(c, args.max_chars_per_comment !== undefined ? { maxChars: args.max_chars_per_comment } : {}),
          ),
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_bug_history",
    {
      title: "Get bug change history",
      description:
        "Fetch the field-change history of a bug (status/resolution transitions, priority changes, assignee changes, flag changes, CC additions, etc.). Optionally filter to specific fields or a time window.",
      inputSchema: {
        bug_id: idOrAlias.describe("Bug ID or alias"),
        new_since: z.string().optional().describe("Only changes made at/after this time (ISO timestamp or relative like -30d)"),
        fields: z
          .array(z.string())
          .optional()
          .describe("Only include changes to these fields, e.g. ['status', 'resolution', 'priority', 'assigned_to', 'flagtypes.name', 'keywords']"),
        exclude_cc: z.boolean().default(true).describe("Drop CC-list changes, which are usually noise"),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const history = await client.getHistory(args.bug_id, resolveTime(args.new_since));
        const wanted = args.fields ? new Set(args.fields) : undefined;
        const filtered = history
          .map((entry) => ({
            ...entry,
            changes: entry.changes.filter((c) => (wanted ? wanted.has(c.field_name) : true) && (!args.exclude_cc || c.field_name !== "cc")),
          }))
          .filter((entry) => entry.changes.length > 0);
        return json({
          bug_id: args.bug_id,
          url: client.bugUrl(args.bug_id),
          total_entries: filtered.length,
          returned: Math.min(filtered.length, args.limit),
          history: filtered.slice(0, args.limit),
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_bug_attachments",
    {
      title: "List bug attachments",
      description:
        "List attachments (patches, screenshots, logs, test cases) on a bug with metadata. Attachment content is not included; use get_attachment to fetch a specific attachment's content.",
      inputSchema: {
        bug_id: idOrAlias.describe("Bug ID or alias"),
        include_obsolete: z.boolean().default(false).describe("Include attachments marked obsolete"),
      },
      annotations: readOnly,
    },
    async ({ bug_id, include_obsolete }) =>
      run(async () => {
        const attachments = await client.getBugAttachments(bug_id, false);
        const visible = include_obsolete ? attachments : attachments.filter((a) => !a.is_obsolete);
        return json({
          bug_id,
          url: client.bugUrl(bug_id),
          total_attachments: attachments.length,
          returned: visible.length,
          attachments: visible.map((a) => formatAttachment(a, client)),
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_attachment",
    {
      title: "Get attachment",
      description:
        "Fetch a single attachment by ID. Text-based attachments (patches, logs, text, JSON, HTML, source code) are returned decoded as text; binary attachments are returned as base64 when `include_content` is set.",
      inputSchema: {
        attachment_id: z.number().int().positive(),
        include_content: z.boolean().default(true).describe("Include the attachment content"),
        max_chars: z.number().int().min(1000).default(100_000).describe("Truncate decoded text content to this many characters"),
      },
      annotations: readOnly,
    },
    async ({ attachment_id, include_content, max_chars }) =>
      run(async () => {
        const attachment = await client.getAttachment(attachment_id, include_content);
        const formatted = formatAttachment(attachment, client);
        const data = formatted.data as string | undefined;
        delete formatted.data;
        if (include_content && data !== undefined) {
          const isText =
            /^(text\/|application\/(json|xml|javascript|x-javascript|x-patch|x-diff|mbox|x-sh|toml|yaml|x-yaml))/i.test(attachment.content_type) ||
            Boolean(attachment.is_patch);
          if (isText) {
            const text = Buffer.from(data, "base64").toString("utf8");
            formatted.content = text.length > max_chars ? `${text.slice(0, max_chars)}…` : text;
            formatted.content_truncated = text.length > max_chars || undefined;
          } else {
            formatted.content_base64 = data;
          }
        }
        return json(formatted);
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_related_bugs",
    {
      title: "Get related bugs",
      description:
        "Resolve every bug linked to the given bug (depends_on, blocks, regressed_by, regressions, duplicates, dupe_of, and same-instance see_also links) and return a summary of each so the relationship graph can be understood in one call.",
      inputSchema: {
        bug_id: idOrAlias.describe("Bug ID or alias"),
        relations: z
          .array(z.enum(["depends_on", "blocks", "regressed_by", "regressions", "duplicates", "dupe_of", "see_also"]))
          .optional()
          .describe("Restrict to these relationship types (default: all)"),
      },
      annotations: readOnly,
    },
    async ({ bug_id, relations }) =>
      run(async () => {
        const bug = await client.getBug(bug_id, [
          "id",
          "summary",
          "status",
          "resolution",
          "depends_on",
          "blocks",
          "regressed_by",
          "regressions",
          "duplicates",
          "dupe_of",
          "see_also",
        ]);
        const wanted = new Set(relations ?? ["depends_on", "blocks", "regressed_by", "regressions", "duplicates", "dupe_of", "see_also"]);
        const groups: Record<string, number[]> = {};
        const externalSeeAlso: string[] = [];
        const add = (name: string, ids: number[] | undefined) => {
          if (wanted.has(name) && ids && ids.length > 0) groups[name] = ids;
        };
        add("depends_on", bug.depends_on);
        add("blocks", bug.blocks);
        add("regressed_by", bug.regressed_by);
        add("regressions", bug.regressions);
        add("duplicates", bug.duplicates);
        add("dupe_of", bug.dupe_of ? [bug.dupe_of] : undefined);
        if (wanted.has("see_also") && bug.see_also) {
          const local: number[] = [];
          for (const link of bug.see_also) {
            const id = bugIdFromSeeAlso(link, client.baseUrl);
            if (id !== undefined) local.push(id);
            else externalSeeAlso.push(link);
          }
          add("see_also", local);
        }

        const allIds = [...new Set(Object.values(groups).flat())];
        const summaries = allIds.length > 0 ? await fetchBugsBatched(client, allIds, SUMMARY_FIELDS) : [];
        const byId = new Map(summaries.map((b) => [b.id, formatBug(b, client)]));

        const related: Record<string, unknown[]> = {};
        for (const [name, ids] of Object.entries(groups)) {
          related[name] = ids.map((id) => byId.get(id) ?? { id, url: client.bugUrl(id), inaccessible: true });
        }

        return json({
          bug: { id: bug.id, summary: bug.summary, status: bug.status, resolution: bug.resolution, url: client.bugUrl(bug.id) },
          related_count: allIds.length,
          related,
          ...(externalSeeAlso.length > 0 ? { external_see_also: externalSeeAlso } : {}),
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List Bugzilla products (e.g. Firefox, Core, Toolkit, DevTools, Fenix, GeckoView, Thunderbird, Web Compatibility). Returns names and descriptions; use get_product to see a product's components.",
      inputSchema: {
        type: z
          .enum(["selectable", "enterable", "accessible"])
          .default("enterable")
          .describe("selectable = products you can search, enterable = products you can file bugs in, accessible = union"),
        include_inactive: z.boolean().default(false),
        name_filter: z.string().optional().describe("Case-insensitive substring to filter product names"),
      },
      annotations: readOnly,
    },
    async ({ type, include_inactive, name_filter }) =>
      run(async () => {
        const ids = await client.listProductIds(type);
        const products = await client.getProducts(ids, ["id", "name", "description", "is_active", "classification"]);
        const needle = name_filter?.toLowerCase();
        const filtered = products
          .filter((p) => include_inactive || p.is_active !== false)
          .filter((p) => !needle || p.name.toLowerCase().includes(needle))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => formatProduct(p));
        return json({ count: filtered.length, products: filtered });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_product",
    {
      title: "Get product components",
      description:
        "Get a product's details including its components (with descriptions and triage owners), active versions, and milestones. Use this to find the right component name before filing or searching.",
      inputSchema: {
        product: z.string().min(1).describe("Product name, e.g. 'Firefox' or 'Core'"),
        include_inactive_components: z.boolean().default(false),
        component_filter: z.string().optional().describe("Case-insensitive substring to filter component names/descriptions"),
        include_versions_and_milestones: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    async ({ product, include_inactive_components, component_filter, include_versions_and_milestones }) =>
      run(async () => {
        const fields = [
          "id",
          "name",
          "description",
          "is_active",
          "classification",
          "default_milestone",
          "components.name",
          "components.description",
          "components.is_active",
          "components.triage_owner",
          "components.team_name",
          "components.default_assigned_to",
        ];
        if (include_versions_and_milestones) fields.push("versions", "milestones");
        const result = await client.getProduct(product, fields);
        if (component_filter && result.components) {
          const needle = component_filter.toLowerCase();
          result.components = result.components.filter(
            (c) => c.name.toLowerCase().includes(needle) || (c.description ?? "").toLowerCase().includes(needle),
          );
        }
        return json(formatProduct(result, { includeInactiveComponents: include_inactive_components }));
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_field_values",
    {
      title: "Get legal field values",
      description:
        "Get the legal values for a bug field (e.g. status, resolution, priority, severity, bug_type, keywords, platform, op_sys, or any cf_* custom field). Useful for building precise searches.",
      inputSchema: {
        field: z.string().min(1).describe("Field name, e.g. 'status', 'resolution', 'priority', 'severity', 'type', 'keywords', 'op_sys', 'platform', or a cf_* custom field"),
        include_inactive: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    async ({ field, include_inactive }) =>
      run(async () => {
        const info = await client.getField(FIELD_ALIASES[field.toLowerCase()] ?? field);
        const values = (info.values ?? [])
          .filter((v) => include_inactive || v.is_active !== false)
          .map((v) => ({
            name: v.name,
            ...(v.is_open !== undefined ? { is_open: v.is_open } : {}),
            ...(v.can_change_to ? { can_change_to: v.can_change_to.map((t) => t.name) } : {}),
          }));
        return json({
          field: info.name,
          display_name: info.display_name,
          is_custom: info.is_custom,
          value_count: values.length,
          values,
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_user",
    {
      title: "Look up users",
      description:
        "Look up Bugzilla users by login/email, numeric ID, or a fuzzy match on name/nickname (e.g. ':dholbert'). Note: bugzilla.mozilla.org only allows user lookups when authenticated with BUGZILLA_API_KEY.",
      inputSchema: {
        names: z.array(z.string().min(1)).optional().describe("Exact login names / emails"),
        ids: z.array(z.number().int().positive()).optional().describe("Numeric user IDs"),
        match: z.array(z.string().min(1)).optional().describe("Fuzzy match strings (matched against login, real name and nickname)"),
      },
      annotations: readOnly,
    },
    async ({ names, ids, match }) =>
      run(async () => {
        if (!names && !ids && !match) throw new Error("Provide at least one of names, ids, or match");
        const users = await client.getUsers({
          ...(names ? { names } : {}),
          ...(ids ? { ids } : {}),
          ...(match ? { match } : {}),
        });
        return json({
          count: users.length,
          users: users.map((u) => ({
            id: u.id,
            login: u.name,
            real_name: u.real_name,
            ...(u.nick ? { nick: u.nick } : {}),
            ...(u.email && u.email !== u.name ? { email: u.email } : {}),
            ...(u.can_login !== undefined ? { can_login: u.can_login } : {}),
          })),
        });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerTool(
    "whoami",
    {
      title: "Current user / server info",
      description:
        "Report which Bugzilla instance this server talks to, its version, and (if BUGZILLA_API_KEY is configured) the authenticated user.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () =>
      run(async () => {
        const version = await client.version();
        const base = { bugzilla_url: client.baseUrl, bugzilla_version: version.version, authenticated: client.hasApiKey };
        if (!client.hasApiKey) return json({ ...base, note: "Set BUGZILLA_API_KEY to access private bugs, user lookups and higher rate limits." });
        const me = await client.whoami();
        return json({ ...base, user: { id: me.id, login: me.name, real_name: me.real_name, ...(me.nick ? { nick: me.nick } : {}) } });
      }),
  );

  // ---------------------------------------------------------------------------
  server.registerResource(
    "bug",
    new ResourceTemplate("bugzilla://bug/{id}", { list: undefined }),
    {
      title: "Bugzilla bug",
      description: "A bugzilla.mozilla.org bug (metadata plus its full comment thread) as JSON.",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const bugId = Array.isArray(id) ? id[0] : id;
      if (!bugId) throw new Error("Missing bug id in resource URI");
      const [bug, comments] = await Promise.all([client.getBug(bugId, DETAIL_FIELDS), client.getComments(bugId)]);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...formatBug(bug, client), comments: comments.map((c) => formatComment(c)) }, null, 2),
          },
        ],
      };
    },
  );
}
