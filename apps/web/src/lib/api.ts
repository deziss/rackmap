import type { ErrorResponse } from "@inv/shared";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/**
 * sudo on a managed host needs a password RackMap does not have (or rejected
 * the saved one). The API refuses before any root command runs, so retrying
 * the same request with a password is safe.
 */
export function isSudoPasswordError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    (err.code === "SUDO_ERROR" || err.code === "VAULT_LOCKED") &&
    /password/i.test(err.message)
  );
}

export interface SudoPromptRequest {
  /** Server the request targets, when it can be told from the URL or body. */
  serverId: number | null;
  /** The API's explanation, shown in the prompt. */
  message: string;
  /** True when a password typed a moment ago was rejected too. */
  retry: boolean;
}

export interface SudoPromptAnswer {
  password: string;
  /** Keep it in memory for this server until the page reloads. */
  remember: boolean;
  /** Also store it as the server's saved password (PATCH /servers/:id). */
  saveToServer: boolean;
}

type SudoPrompt = (req: SudoPromptRequest) => Promise<SudoPromptAnswer | null>;

let sudoPrompt: SudoPrompt | null = null;
/** Memory only — never written to storage. Keyed by server id ("*" when unknown). */
const rememberedSudo = new Map<string, string>();

/** Installed by <SudoPromptHost/>; returns an unregister function. */
export function registerSudoPrompt(fn: SudoPrompt): () => void {
  sudoPrompt = fn;
  return () => {
    if (sudoPrompt === fn) sudoPrompt = null;
  };
}

function targetServerId(path: string, init?: RequestInit): number | null {
  const m = path.match(/^\/api\/v1\/servers\/(\d+)(?:\/|$|\?)/);
  if (m) return Number(m[1]);
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body) as { serverId?: unknown };
      if (typeof body.serverId === "number") return body.serverId;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

async function send(path: string, init: RequestInit | undefined, sudoPassword?: string): Promise<Response> {
  // Spread `init` first: its own `headers` must not replace the JSON content type.
  return fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
      ...(sudoPassword ? { "X-Sudo-Password": sudoPassword } : {}),
    },
  });
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorResponse | undefined;
  try {
    body = (await res.json()) as ErrorResponse;
  } catch {
    // ignore parse failures
  }
  return new ApiError(body?.error.code ?? "UNKNOWN", body?.error.message ?? res.statusText, res.status);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const serverId = targetServerId(path, init);
  const key = serverId === null ? "*" : String(serverId);
  const explicit = new Headers(init?.headers).has("X-Sudo-Password");
  let sudoPassword = explicit ? undefined : rememberedSudo.get(key);
  let answer: SudoPromptAnswer | null = null;

  let res = await send(path, init, sudoPassword);
  // Up to three attempts at a sudo password, asked once per failure.
  for (let attempt = 0; !res.ok && attempt < 3; attempt++) {
    const err = await toApiError(res);
    if (!isSudoPasswordError(err) || explicit || !sudoPrompt) throw err;
    if (sudoPassword) rememberedSudo.delete(key);
    answer = await sudoPrompt({ serverId, message: err.message, retry: Boolean(sudoPassword) });
    if (!answer) throw err;
    sudoPassword = answer.password;
    res = await send(path, init, sudoPassword);
  }

  if (!res.ok) throw await toApiError(res);

  if (answer && sudoPassword) {
    if (answer.remember) rememberedSudo.set(key, sudoPassword);
    if (answer.saveToServer && serverId !== null) {
      // Best effort: the action already succeeded; a failed save only means asking again next time.
      await send(`/api/v1/servers/${serverId}`, { method: "PATCH", body: JSON.stringify({ password: sudoPassword }) }).catch(
        () => undefined,
      );
    }
  }

  // 204 or empty body
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}
