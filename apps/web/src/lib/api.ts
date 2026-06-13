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

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });

  if (!res.ok) {
    let body: ErrorResponse | undefined;
    try {
      body = await res.json() as ErrorResponse;
    } catch {
      // ignore parse failures
    }
    throw new ApiError(
      body?.error.code ?? "UNKNOWN",
      body?.error.message ?? res.statusText,
      res.status,
    );
  }

  // 204 or empty body
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}
