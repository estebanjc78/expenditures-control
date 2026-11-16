import type { MailMessage, MailSource } from "./source.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 500;
const MAX_ATTEMPTS = 3;
const MAX_BODY_CHARS = 200_000;
const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const QUOTA_RE = /quota|rate limit/i;
const QUOTA_WAIT_MS = 15_000; // the per-minute window needs real time to clear, not milliseconds
const QUOTA_HELP = "Google limitó temporalmente las lecturas de Gmail (límite de lecturas por minuto). Espera un minuto y vuelve a ejecutarlo: lo ya cargado se conserva y continúa donde quedó.";

interface Part {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
}

interface ApiMessage {
  id: string;
  internalDate?: string;
  payload?: Part;
}

export interface GmailClientDeps {
  readonly fetchFn?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const decode = (data: string): string => Buffer.from(data, "base64url").toString("utf8");

function findBody(part: Part | undefined, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findBody(child, mime);
    if (found !== null) return found;
  }
  return null;
}

function header(part: Part | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Gmail REST API (read-only) as a MailSource. */
export class GmailApiSource implements MailSource {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly getToken: () => Promise<string>,
    deps: GmailClientDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${API}${path}?${new URLSearchParams(params).toString()}`;
    for (let attempt = 1; ; attempt += 1) {
      const res = await this.fetchFn(url, {
        headers: { authorization: `Bearer ${await this.getToken()}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as T;
      const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? res.statusText;
      // Google reports the per-minute quota as 403 (not 429), so it is recognised by its message.
      const overQuota = res.status === 429 || (res.status === 403 && QUOTA_RE.test(detail));
      if (attempt < MAX_ATTEMPTS && (overQuota || RETRYABLE.has(res.status))) {
        await this.sleep(overQuota ? QUOTA_WAIT_MS * attempt : 500 * attempt);
        continue;
      }
      throw new Error(overQuota ? QUOTA_HELP : `Gmail API ${res.status}: ${detail}`);
    }
  }

  async listMessageIds(query: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      const page = await this.get<{ messages?: { id: string }[]; nextPageToken?: string }>("/messages", {
        q: query,
        maxResults: String(Math.min(PAGE_SIZE, limit - ids.length)),
        ...(pageToken ? { pageToken } : {}),
      });
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < limit && pages < MAX_PAGES);
    return ids.slice(0, limit);
  }

  async getMessage(id: string): Promise<MailMessage> {
    const m = await this.get<ApiMessage>(`/messages/${encodeURIComponent(id)}`, { format: "full" });
    const body = findBody(m.payload, "text/plain") ?? findBody(m.payload, "text/html") ?? decode(m.payload?.body?.data ?? "");
    return {
      id: m.id,
      subject: header(m.payload, "Subject"),
      from: header(m.payload, "From"),
      receivedAt: Number(m.internalDate ?? 0),
      body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body,
    };
  }
}
