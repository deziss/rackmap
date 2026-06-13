import type { Context } from "hono";
import type { ErrorCode } from "@inv/shared";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(entity: string) {
  return new AppError("NOT_FOUND", `${entity} not found`, 404);
}

export function conflict(message: string) {
  return new AppError("CONFLICT", message, 409);
}

export function forbidden(message = "Forbidden") {
  return new AppError("FORBIDDEN", message, 403);
}

export function onError(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  }
  console.error("[unhandled]", err);
  return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
}
