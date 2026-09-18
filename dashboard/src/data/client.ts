/**
 * The dashboard's one HTTP transport. This is the ONLY production module that
 * may touch the global `fetch` (enforced by `scripts/check-dashboard-architecture.mjs`
 * from Task 6); every hook, mutation, and stateful controller reaches the server
 * through the functions exported here or through an injected {@link FetchLike}
 * whose default comes from here.
 *
 * Three layers:
 * - {@link requestResponse}: fetch-shaped passthrough that returns the raw
 *   `Response` untouched. The stage-dispatch receipt protocol needs the status
 *   and raw body (a 2xx with an unreadable body means "unknown", never
 *   "failed"), so it must not be reinterpreted here.
 * - {@link requestJson}: JSON request/response with a typed {@link ApiError}
 *   that preserves `status`, the parsed body (`next`, dispatch warnings, …) and
 *   204/empty-body semantics.
 * - {@link uploadBinary}: raw Blob/ArrayBuffer upload with caller headers.
 *
 * Tests inject a fetch implementation via {@link createApiClient}; the default
 * client resolves `globalThis.fetch` lazily on every call so `vi.stubGlobal`
 * still reaches it.
 */

/** Fetch-shaped transport. `typeof fetch` is assignable to it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiErrorKind =
  /** The server answered with a non-2xx status. */
  | 'http'
  /** No response at all (offline, DNS, reset). Whether a write landed is unknown. */
  | 'network'
  /** A 2xx whose body could not be parsed as JSON. */
  | 'malformed';

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;
  /** Parsed JSON body when there was one (error responses keep `next`, warnings, dispatch…). */
  readonly body: unknown;
  readonly url: string;

  constructor(args: { message: string; status: number; kind: ApiErrorKind; body?: unknown; url: string; cause?: unknown }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.kind = args.kind;
    this.body = args.body ?? null;
    this.url = args.url;
    if (args.cause !== undefined) (this as { cause?: unknown }).cause = args.cause;
  }

  /** The server's `next` hint on a refused lifecycle verb, when present. */
  get next(): string | null {
    const next = (this.body as { next?: unknown } | null)?.next;
    return typeof next === 'string' && next.length > 0 ? next : null;
  }

  /** True when the request may or may not have been applied server-side. */
  get uncertain(): boolean {
    return this.kind === 'network' || this.kind === 'malformed' || (this.kind === 'http' && this.status >= 500);
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isAbortError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'AbortError'
  );
}

/** Human-readable message for any thrown value (UI error states). */
export function errorMessage(value: unknown, fallback = 'Request failed'): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback;
}

export interface JsonRequestInit extends Omit<RequestInit, 'body'> {
  /** Serialized with JSON.stringify and sent as application/json. */
  json?: unknown;
  /** Raw body (string/FormData/Blob/…). A string body defaults to application/json. */
  body?: BodyInit | null;
}

export interface ApiClient {
  readonly fetch: FetchLike;
  requestResponse(url: string, init?: RequestInit): Promise<Response>;
  requestJson<T>(url: string, init?: JsonRequestInit): Promise<T>;
  uploadBinary<T>(
    url: string,
    body: Blob | ArrayBuffer | Uint8Array,
    init?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal },
  ): Promise<T>;
}

// The single production reference to the global fetch. Resolved per call so a
// test that stubs the global after import is still honoured.
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function hasHeader(headers: HeadersInit | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.has(name);
  if (Array.isArray(headers)) return headers.some(([k]) => k.toLowerCase() === lower);
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function withHeader(headers: HeadersInit | undefined, name: string, value: string): HeadersInit {
  if (!headers) return { [name]: value };
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set(name, value);
    return copy;
  }
  if (Array.isArray(headers)) return [...headers, [name, value]];
  return { ...headers, [name]: value };
}

function messageFromBody(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; errors?: unknown; message?: unknown };
    if (Array.isArray(b.errors) && b.errors.length > 0 && b.errors.every((e) => typeof e === 'string')) {
      return (b.errors as string[]).join('; ');
    }
    if (typeof b.error === 'string' && b.error) return b.error;
    if (typeof b.message === 'string' && b.message) return b.message;
  }
  return `HTTP ${status}`;
}

/** Read and JSON-parse a body; `undefined` for 204/205/empty. */
async function readBody(response: Response): Promise<{ ok: true; value: unknown } | { ok: false; text: string }> {
  if (response.status === 204 || response.status === 205) return { ok: true, value: undefined };
  const text = await response.text();
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, text };
  }
}

/** Turn a settled `Response` into parsed JSON or a typed {@link ApiError}. */
export async function parseJsonResponse<T>(response: Response, url: string): Promise<T> {
  let parsed: Awaited<ReturnType<typeof readBody>>;
  try {
    parsed = await readBody(response);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError({
      message: response.ok ? 'Malformed response' : `HTTP ${response.status}`,
      status: response.status,
      kind: response.ok ? 'malformed' : 'http',
      url,
      cause: err,
    });
  }
  if (!response.ok) {
    const body = parsed.ok ? parsed.value : null;
    throw new ApiError({ message: messageFromBody(body, response.status), status: response.status, kind: 'http', body, url });
  }
  if (!parsed.ok) {
    throw new ApiError({ message: 'Malformed response', status: response.status, kind: 'malformed', url });
  }
  return parsed.value as T;
}

export function createApiClient(fetchImpl: FetchLike = globalFetch): ApiClient {
  async function send(url: string, init: RequestInit | undefined): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ApiError({ message: errorMessage(err, 'Network error'), status: 0, kind: 'network', url, cause: err });
    }
  }

  return {
    fetch: fetchImpl,
    requestResponse: (url, init) => fetchImpl(url, init),
    async requestJson<T>(url: string, init: JsonRequestInit = {}): Promise<T> {
      const { json, body, headers, ...rest } = init;
      let finalBody: BodyInit | null | undefined = body;
      let finalHeaders = headers;
      if (json !== undefined) {
        finalBody = JSON.stringify(json);
        if (!hasHeader(finalHeaders, 'content-type')) finalHeaders = withHeader(finalHeaders, 'Content-Type', 'application/json');
      } else if (typeof body === 'string' && !hasHeader(finalHeaders, 'content-type')) {
        finalHeaders = withHeader(finalHeaders, 'Content-Type', 'application/json');
      }
      const requestInit: RequestInit = { ...rest };
      if (finalHeaders !== undefined) requestInit.headers = finalHeaders;
      if (finalBody !== undefined) requestInit.body = finalBody;
      const response = await send(url, requestInit);
      return parseJsonResponse<T>(response, url);
    },
    async uploadBinary<T>(
      url: string,
      body: Blob | ArrayBuffer | Uint8Array,
      init: { headers?: Record<string, string>; method?: string; signal?: AbortSignal } = {},
    ): Promise<T> {
      const headers = { 'Content-Type': 'application/octet-stream', ...(init.headers ?? {}) };
      const response = await send(url, {
        method: init.method ?? 'POST',
        headers,
        body: body as BodyInit,
        ...(init.signal ? { signal: init.signal } : {}),
      });
      return parseJsonResponse<T>(response, url);
    },
  };
}

/** Browser/default client. Resolves the global fetch lazily. */
export const defaultApiClient: ApiClient = createApiClient();

/** Raw passthrough (status + body untouched) — the stateful receipt protocol's default transport. */
export const requestResponse: FetchLike = (input, init) => defaultApiClient.requestResponse(input, init);

export function requestJson<T>(url: string, init?: JsonRequestInit): Promise<T> {
  return defaultApiClient.requestJson<T>(url, init);
}

export function uploadBinary<T>(
  url: string,
  body: Blob | ArrayBuffer | Uint8Array,
  init?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal },
): Promise<T> {
  return defaultApiClient.uploadBinary<T>(url, body, init);
}
