import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The bearer token is a password: it opens remote read and write access to the
 * user's own messenger account. It is compared in constant time, never logged,
 * and never accepted from a query string.
 */
export const MIN_TOKEN_LENGTH = 16;

export class TokenError extends Error {}

export function checkToken(token: string): string {
  if (token.length < MIN_TOKEN_LENGTH)
    throw new TokenError(
      `The token must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  if (/\s/.test(token))
    throw new TokenError("The token must not contain whitespace");
  return token;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  // Hashing first gives both sides one length, so the comparison leaks neither
  // the token's length nor how much of it matched.
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(token));
}
