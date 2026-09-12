import type { Attachment, Bug, BugzillaClient, Comment, Component, Product, UserDetail } from "./bugzilla.js";

export const SUMMARY_FIELDS = [
  "id",
  "summary",
  "status",
  "resolution",
  "product",
  "component",
  "type",
  "priority",
  "severity",
  "assigned_to",
  "creation_time",
  "last_change_time",
  "keywords",
  "whiteboard",
];

export const DETAIL_FIELDS = [
  ...SUMMARY_FIELDS,
  "alias",
  "version",
  "platform",
  "op_sys",
  "url",
  "creator",
  "creator_detail",
  "assigned_to_detail",
  "qa_contact",
  "target_milestone",
  "cf_last_resolved",
  "blocks",
  "depends_on",
  "regressed_by",
  "regressions",
  "dupe_of",
  "duplicates",
  "see_also",
  "flags",
  "cc",
  "is_open",
  "is_confirmed",
  "comment_count",
  "votes",
  "groups",
];

/** Bugzilla returns `nobody@mozilla.org` for unassigned bugs; render that clearly. */
function person(name: string | undefined, detail: UserDetail | undefined): string | undefined {
  if (!name) return undefined;
  if (name === "nobody@mozilla.org") return "unassigned";
  if (detail?.real_name && detail.real_name !== name) return `${detail.real_name} <${name}>`;
  return name;
}

function nonEmpty<T>(value: T[] | undefined): T[] | undefined {
  return value && value.length > 0 ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete obj[key];
  }
  return obj;
}

const BUG_KEY_ORDER = [
  "id",
  "url",
  "alias",
  "summary",
  "type",
  "status",
  "resolution",
  "is_open",
  "product",
  "component",
  "priority",
  "severity",
  "keywords",
  "whiteboard",
  "assigned_to",
  "creator",
  "qa_contact",
  "creation_time",
  "last_change_time",
  "cf_last_resolved",
  "target_milestone",
  "version",
  "platform",
  "op_sys",
  "related_url",
  "depends_on",
  "blocks",
  "regressed_by",
  "regressions",
  "dupe_of",
  "duplicates",
  "see_also",
  "flags",
  "comment_count",
  "cc_count",
  "cc",
];

function orderKeys(obj: Record<string, unknown>, order: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) if (key in obj) out[key] = obj[key];
  for (const key of Object.keys(obj).sort()) if (!(key in out)) out[key] = obj[key];
  return out;
}

export interface FormatBugOptions {
  /** Include the full CC list (off by default because it is long and rarely useful; cc_count is always included). */
  includeCc?: boolean;
}

export function formatBug(bug: Bug, client: BugzillaClient, opts: FormatBugOptions = {}): Record<string, unknown> {
  const { creator_detail, assigned_to_detail, cc_detail, cc, flags, url: bugUrlField, ...rest } = bug;
  const out: Record<string, unknown> = {
    ...rest,
    url: client.bugUrl(bug.id),
    // The bug's own "URL" field (a link to a testcase/site) is distinct from the bug's Bugzilla URL.
    related_url: typeof bugUrlField === "string" ? bugUrlField : undefined,
    creator: person(bug.creator, creator_detail),
    assigned_to: person(bug.assigned_to, assigned_to_detail),
    qa_contact: bug.qa_contact === "" ? undefined : bug.qa_contact,
    cc: opts.includeCc ? nonEmpty(cc) : undefined,
    cc_count: cc ? cc.length : undefined,
    flags: nonEmpty(flags?.map((f) => stripUndefined({ name: f.name, status: f.status, setter: f.setter, requestee: f.requestee }))),
  };
  return orderKeys(stripUndefined(out), BUG_KEY_ORDER);
}

export function formatComment(comment: Comment, opts: { maxChars?: number } = {}): Record<string, unknown> {
  let text = comment.text;
  let truncated = false;
  if (opts.maxChars !== undefined && text.length > opts.maxChars) {
    text = `${text.slice(0, opts.maxChars)}…`;
    truncated = true;
  }
  return stripUndefined({
    id: comment.id,
    count: comment.count,
    creator: comment.creator,
    creation_time: comment.creation_time,
    is_private: comment.is_private || undefined,
    attachment_id: comment.attachment_id ?? undefined,
    tags: nonEmpty(comment.tags),
    text,
    truncated: truncated || undefined,
  });
}

const PHABRICATOR_URL = "https://phabricator.services.mozilla.com";

/** Modern BMO patches are Phabricator revisions attached as `phabricator-D12345-url.txt` stubs. */
function phabricatorUrl(attachment: Attachment): string | undefined {
  if (attachment.content_type !== "text/x-phabricator-request") return undefined;
  const match = /D\d+/.exec(attachment.file_name ?? "");
  return match ? `${PHABRICATOR_URL}/${match[0]}` : undefined;
}

export function formatAttachment(attachment: Attachment, client: BugzillaClient): Record<string, unknown> {
  const { data, creator_detail, ...rest } = attachment;
  return stripUndefined({
    ...rest,
    phabricator_url: phabricatorUrl(attachment),
    creator: person(attachment.creator, creator_detail),
    is_patch: Boolean(attachment.is_patch),
    is_obsolete: Boolean(attachment.is_obsolete),
    is_private: Boolean(attachment.is_private),
    flags: nonEmpty(attachment.flags?.map((f) => stripUndefined({ name: f.name, status: f.status, setter: f.setter, requestee: f.requestee }))),
    url: client.attachmentUrl(attachment.id),
    data,
  });
}

export function stripHtml(html: string | undefined): string | undefined {
  if (!html) return html;
  return html
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

export function formatComponent(component: Component): Record<string, unknown> {
  return stripUndefined({
    name: component.name,
    description: stripHtml(component.description),
    is_active: component.is_active,
    triage_owner: component.triage_owner,
    team_name: component.team_name,
    default_assigned_to: component.default_assigned_to === "nobody@mozilla.org" ? undefined : component.default_assigned_to,
  });
}

export function formatProduct(product: Product, opts: { includeInactiveComponents?: boolean } = {}): Record<string, unknown> {
  const components = product.components?.filter((c) => opts.includeInactiveComponents || c.is_active !== false);
  return stripUndefined({
    id: product.id,
    name: product.name,
    description: stripHtml(product.description),
    is_active: product.is_active,
    classification: product.classification,
    default_milestone: product.default_milestone,
    component_count: components?.length,
    components: components?.map(formatComponent),
    versions: nonEmpty(product.versions?.filter((v) => v.is_active).map((v) => v.name)),
    milestones: nonEmpty(product.milestones?.filter((m) => m.is_active).map((m) => m.name)),
  });
}

/** Extracts a Bugzilla bug id from a see_also URL when it points at the same instance. */
export function bugIdFromSeeAlso(url: string, baseUrl: string): number | undefined {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.host !== base.host) return undefined;
    const id = parsed.searchParams.get("id");
    if (id && /^\d+$/.test(id)) return Number(id);
    const match = parsed.pathname.match(/^\/(\d+)$/);
    return match?.[1] ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}
