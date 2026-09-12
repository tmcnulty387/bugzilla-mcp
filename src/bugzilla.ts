/**
 * Thin client for the Bugzilla REST API (https://bmo.readthedocs.io/en/latest/api/).
 */

export const DEFAULT_BASE_URL = "https://bugzilla.mozilla.org";

export type QueryValue = string | number | boolean | Array<string | number> | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface BugzillaClientOptions {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  userAgent?: string | undefined;
}

export class BugzillaError extends Error {
  readonly code: number | undefined;
  readonly httpStatus: number | undefined;
  readonly documentation: string | undefined;

  constructor(message: string, opts: { code?: number; httpStatus?: number; documentation?: string } = {}) {
    super(message);
    this.name = "BugzillaError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.documentation = opts.documentation;
  }
}

interface BugzillaErrorBody {
  error: true;
  code?: number;
  message?: string;
  documentation?: string;
}

function isErrorBody(value: unknown): value is BugzillaErrorBody {
  return typeof value === "object" && value !== null && (value as { error?: unknown }).error === true;
}

export class BugzillaClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: BugzillaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey && options.apiKey.trim() !== "" ? options.apiKey.trim() : undefined;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.userAgent = options.userAgent ?? "firefox-bugzilla-mcp/0.1.0";
  }

  get hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }

  bugUrl(id: number | string): string {
    return `${this.baseUrl}/show_bug.cgi?id=${encodeURIComponent(String(id))}`;
  }

  attachmentUrl(id: number | string): string {
    return `${this.baseUrl}/attachment.cgi?id=${encodeURIComponent(String(id))}`;
  }

  buildUrl(path: string, params: QueryParams = {}): URL {
    const url = new URL(`${this.baseUrl}/rest/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
    return url;
  }

  async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = this.buildUrl(path, params);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.apiKey) headers["X-BUGZILLA-API-KEY"] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new BugzillaError(`Request to ${url.pathname} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new BugzillaError(
        `Bugzilla returned non-JSON response (HTTP ${response.status}) for ${url.pathname}: ${text.slice(0, 200)}`,
        { httpStatus: response.status },
      );
    }

    if (isErrorBody(body)) {
      throw new BugzillaError(body.message ?? `Bugzilla error ${body.code ?? "unknown"}`, {
        ...(body.code !== undefined ? { code: body.code } : {}),
        httpStatus: response.status,
        ...(body.documentation !== undefined ? { documentation: body.documentation } : {}),
      });
    }
    if (!response.ok) {
      throw new BugzillaError(`Bugzilla returned HTTP ${response.status} for ${url.pathname}`, {
        httpStatus: response.status,
      });
    }
    return body as T;
  }

  // ---- Bugs -------------------------------------------------------------

  searchBugs(params: QueryParams): Promise<{ bugs: Bug[] }> {
    return this.get<{ bugs: Bug[] }>("bug", params);
  }

  getBugs(ids: Array<number | string>, includeFields?: string[]): Promise<{ bugs: Bug[]; faults?: unknown[] }> {
    return this.get<{ bugs: Bug[]; faults?: unknown[] }>("bug", {
      id: ids.join(","),
      include_fields: includeFields?.join(","),
    });
  }

  async getBug(id: number | string, includeFields?: string[]): Promise<Bug> {
    const result = await this.get<{ bugs: Bug[] }>(`bug/${encodeURIComponent(String(id))}`, {
      include_fields: includeFields?.join(","),
    });
    const bug = result.bugs[0];
    if (!bug) throw new BugzillaError(`Bug ${id} not found`, { code: 101 });
    return bug;
  }

  async getComments(bugId: number | string, newSince?: string): Promise<Comment[]> {
    const result = await this.get<{ bugs: Record<string, { comments: Comment[] }> }>(
      `bug/${encodeURIComponent(String(bugId))}/comment`,
      { new_since: newSince },
    );
    const entry = Object.values(result.bugs)[0];
    return entry?.comments ?? [];
  }

  async getHistory(bugId: number | string, newSince?: string): Promise<HistoryEntry[]> {
    const result = await this.get<{ bugs: Array<{ id: number; alias?: string; history: HistoryEntry[] }> }>(
      `bug/${encodeURIComponent(String(bugId))}/history`,
      { new_since: newSince },
    );
    return result.bugs[0]?.history ?? [];
  }

  async getBugAttachments(bugId: number | string, includeData = false): Promise<Attachment[]> {
    const result = await this.get<{ bugs: Record<string, Attachment[]> }>(
      `bug/${encodeURIComponent(String(bugId))}/attachment`,
      { exclude_fields: includeData ? undefined : "data" },
    );
    return Object.values(result.bugs)[0] ?? [];
  }

  async getAttachment(attachmentId: number | string, includeData = false): Promise<Attachment> {
    const result = await this.get<{ attachments: Record<string, Attachment> }>(
      `bug/attachment/${encodeURIComponent(String(attachmentId))}`,
      { exclude_fields: includeData ? undefined : "data" },
    );
    const attachment = result.attachments[String(attachmentId)] ?? Object.values(result.attachments)[0];
    if (!attachment) throw new BugzillaError(`Attachment ${attachmentId} not found`);
    return attachment;
  }

  // ---- Products / fields -------------------------------------------------

  async listProductIds(type: "selectable" | "enterable" | "accessible" = "selectable"): Promise<number[]> {
    const result = await this.get<{ ids: number[] }>(`product_${type}`);
    return result.ids;
  }

  async getProducts(idsOrNames: Array<number | string>, includeFields?: string[]): Promise<Product[]> {
    const ids = idsOrNames.filter((v) => typeof v === "number" || /^\d+$/.test(v));
    const names = idsOrNames.filter((v) => typeof v === "string" && !/^\d+$/.test(v));
    const result = await this.get<{ products: Product[] }>("product", {
      ids: ids.length > 0 ? ids : undefined,
      names: names.length > 0 ? names : undefined,
      include_fields: includeFields?.join(","),
    });
    return result.products;
  }

  async getProduct(name: string, includeFields?: string[]): Promise<Product> {
    const result = await this.get<{ products: Product[] }>(`product/${encodeURIComponent(name)}`, {
      include_fields: includeFields?.join(","),
    });
    const product = result.products[0];
    if (!product) throw new BugzillaError(`Product "${name}" not found`);
    return product;
  }

  async getField(name: string): Promise<Field> {
    const result = await this.get<{ fields: Field[] }>(`field/bug/${encodeURIComponent(name)}`);
    const field = result.fields[0];
    if (!field) throw new BugzillaError(`Field "${name}" not found`);
    return field;
  }

  // ---- Users ---------------------------------------------------------------

  async getUsers(params: { names?: string[]; ids?: number[]; match?: string[] }): Promise<User[]> {
    const result = await this.get<{ users: User[] }>("user", {
      names: params.names,
      ids: params.ids,
      match: params.match,
    });
    return result.users;
  }

  whoami(): Promise<{ id: number; name: string; real_name: string; nick?: string }> {
    return this.get("whoami");
  }

  version(): Promise<{ version: string }> {
    return this.get("version");
  }
}

// ---- Types -------------------------------------------------------------------

export interface UserDetail {
  id: number;
  name: string;
  email?: string;
  real_name: string;
  nick?: string;
}

export interface Bug {
  id: number;
  alias?: string | string[] | null;
  summary?: string;
  status?: string;
  resolution?: string;
  product?: string;
  component?: string;
  type?: string;
  priority?: string;
  severity?: string;
  version?: string;
  platform?: string;
  op_sys?: string;
  keywords?: string[];
  whiteboard?: string;
  url?: string;
  creator?: string;
  creator_detail?: UserDetail;
  assigned_to?: string;
  assigned_to_detail?: UserDetail;
  qa_contact?: string;
  creation_time?: string;
  last_change_time?: string;
  cf_last_resolved?: string | null;
  blocks?: number[];
  depends_on?: number[];
  regressed_by?: number[];
  regressions?: number[];
  dupe_of?: number | null;
  duplicates?: number[];
  see_also?: string[];
  cc?: string[];
  cc_detail?: UserDetail[];
  flags?: Flag[];
  target_milestone?: string;
  is_open?: boolean;
  is_confirmed?: boolean;
  votes?: number;
  comment_count?: number;
  groups?: string[];
  [key: string]: unknown;
}

export interface Flag {
  id: number;
  name: string;
  status: string;
  setter?: string;
  requestee?: string;
  type_id?: number;
  creation_date?: string;
  modification_date?: string;
}

export interface Comment {
  id: number;
  bug_id?: number;
  attachment_id: number | null;
  count: number;
  text: string;
  creator: string;
  creation_time: string;
  time?: string;
  is_private: boolean;
  tags?: string[];
}

export interface HistoryChange {
  field_name: string;
  removed: string;
  added: string;
  attachment_id?: number;
}

export interface HistoryEntry {
  when: string;
  who: string;
  changes: HistoryChange[];
}

export interface Attachment {
  id: number;
  bug_id: number;
  summary: string;
  description?: string;
  file_name: string;
  content_type: string;
  size: number;
  creator: string;
  creator_detail?: UserDetail;
  creation_time: string;
  last_change_time: string;
  is_patch: number | boolean;
  is_obsolete: number | boolean;
  is_private: number | boolean;
  flags?: Flag[];
  data?: string;
}

export interface Component {
  id?: number;
  name: string;
  description?: string;
  is_active?: boolean;
  default_assigned_to?: string;
  default_qa_contact?: string;
  triage_owner?: string;
  team_name?: string;
}

export interface Product {
  id: number;
  name: string;
  description?: string;
  is_active?: boolean;
  classification?: string;
  default_milestone?: string;
  has_unconfirmed?: boolean;
  components?: Component[];
  versions?: Array<{ id: number; name: string; is_active: boolean }>;
  milestones?: Array<{ id: number; name: string; is_active: boolean; sort_key?: number }>;
}

export interface FieldValue {
  name: string;
  sort_key?: number;
  is_active?: boolean;
  is_open?: boolean;
  can_change_to?: Array<{ name: string; comment_required: boolean }>;
  visibility_values?: string[];
}

export interface Field {
  id: number;
  name: string;
  display_name: string;
  type: number;
  is_custom: boolean;
  is_mandatory: boolean;
  is_on_bug_entry: boolean;
  visibility_field?: string | null;
  visibility_values?: string[];
  value_field?: string | null;
  values?: FieldValue[];
}

export interface User {
  id: number;
  name: string;
  real_name: string;
  email?: string;
  nick?: string;
  can_login?: boolean;
  email_enabled?: boolean;
  login_denied_text?: string;
  groups?: Array<{ id: number; name: string; description: string }>;
}
