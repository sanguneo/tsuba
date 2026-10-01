/**
 * Every answer is an envelope, the same shape the KakaoTalk cores answer:
 * `{ "ok": true, ... }` or `{ "ok": false, "error": { "code", "message" } }`.
 * The HTTP status and the code say the same thing twice on purpose: the status
 * so a proxy or `curl` can branch, the code so a client does not have to guess
 * which of two 503s it got. `message` is for a person; branch on `code`.
 */

export type ErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "NOT_SUPPORTED"
  | "RATE_LIMITED"
  | "BUSY"
  | "INTERNAL";

export const STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHORIZED: 401,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_SUPPORTED: 501,
  RATE_LIMITED: 429,
  BUSY: 503,
  INTERNAL: 500,
};

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function ok(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    headers: HEADERS,
  });
}

export function failure(
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status: STATUS[code],
    headers: { ...HEADERS, ...headers },
  });
}
