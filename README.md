# bugzilla-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents query Firefox's bug tracker, [bugzilla.mozilla.org](https://bugzilla.mozilla.org), for bugs and related information: search, bug details, comment threads, change history, attachments (including Phabricator review links), dependency/regression/duplicate graphs, and product/component/field metadata.

Read-only. Works without credentials for public bugs; an optional API key unlocks private bugs you can see and user lookups.

## Requirements

- Node.js 20 or newer

## Install

```bash
git clone <this repo> bugzilla-mcp
cd bugzilla-mcp
npm install
npm run build
```

The server binary is `dist/index.js` and speaks MCP over stdio.

## Configure your MCP client

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "firefox-bugzilla": {
      "command": "node",
      "args": ["/absolute/path/to/bugzilla-mcp/dist/index.js"],
      "env": {
        "BUGZILLA_API_KEY": "optional"
      }
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "firefox-bugzilla": {
      "command": "node",
      "args": ["/absolute/path/to/bugzilla-mcp/dist/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add firefox-bugzilla -- node /absolute/path/to/bugzilla-mcp/dist/index.js
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUGZILLA_API_KEY` | unset | API key from https://bugzilla.mozilla.org/userprefs.cgi?tab=apikey. Enables private bugs, user lookups, `whoami`, and higher rate limits. |
| `BUGZILLA_URL` | `https://bugzilla.mozilla.org` | Point at another Bugzilla 5+ instance. |
| `BUGZILLA_TIMEOUT_MS` | `60000` | Per-request timeout. |

## Tools

| Tool | What it does |
| --- | --- |
| `search_bugs` | Search with Bugzilla quicksearch syntax and/or structured filters (product, component, status, resolution, type, priority, severity, keywords, whiteboard, summary, assignee, reporter, milestone, version, platform, OS, creation/last-change time). Supports boolean-chart `advanced_filters` for any field, `order`, paging, and `count_only`. |
| `get_bug` | Full metadata for one or more bugs by ID or alias: status/resolution, product/component, assignee, dependencies, regressions, duplicates, flags, see-also, keywords, whiteboard, timestamps. `include_fields: ["_all"]` returns every field including `cf_*` custom fields. |
| `get_bug_comments` | Comment thread with paging, newest-first ordering, `new_since` filtering, and per-comment truncation. Comment #0 is the description. |
| `get_bug_history` | Field-change history (status transitions, priority, assignee, flags, keywords…) with optional field filtering. CC churn is dropped by default. |
| `get_bug_attachments` | Attachment metadata for a bug. Phabricator review stubs are resolved to `phabricator_url`. |
| `get_attachment` | One attachment by ID. Text-based content (patches, logs, JSON, HTML…) is returned decoded; binaries as base64. |
| `get_related_bugs` | Resolves `depends_on`, `blocks`, `regressed_by`, `regressions`, `duplicates`, `dupe_of`, and same-instance `see_also` links into bug summaries in one call. |
| `list_products` | Products you can search or file in, with descriptions. |
| `get_product` | A product's components (descriptions, triage owners, teams), plus versions and milestones on request. |
| `get_field_values` | Legal values for a field (`status`, `resolution`, `priority`, `severity`, `type`, `keywords`, `op_sys`, `platform`, any `cf_*`). |
| `get_user` | Look up users by login, ID, or fuzzy match (requires `BUGZILLA_API_KEY` on bugzilla.mozilla.org). |
| `whoami` | Bugzilla instance, version, and the authenticated user if an API key is set. |

A `bugzilla://bug/{id}` resource template is also exposed; it returns a bug's metadata plus its full comment thread as JSON.

### Search tips for agents

- Quicksearch only matches **open** bugs unless the query starts with `ALL`. Structured filters match all bugs unless `status` is given; use `status: ["__open__"]` or `["__closed__"]`.
- Time filters accept ISO timestamps, dates, or relative shorthand like `-7d`, `-2w`, `-1m`.
- `advanced_filters` map to Bugzilla's boolean charts. Useful fields: `longdesc` (comment text, slow; always narrow with product/status), `cf_crash_signature`, `flagtypes.name` (e.g. `needinfo?`), `commenter`, `cc`, `attachments.mimetype`, `delta_ts` with `changedafter`.
- Discover valid component names with `get_product` before filtering on `component`.

## Development

```bash
npm run dev        # tsc --watch
npm run typecheck
npm run inspect    # open the MCP Inspector against the built server
```

Source layout:

- `src/bugzilla.ts` – minimal Bugzilla REST client (URL building, API-key header, timeouts, error mapping)
- `src/format.ts` – shapes raw API objects into compact, agent-friendly JSON
- `src/tools.ts` – MCP tool and resource registrations
- `src/index.ts` – stdio server entry point

## License

MIT
