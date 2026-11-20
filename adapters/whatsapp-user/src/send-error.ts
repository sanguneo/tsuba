import { AdapterError } from "@tsuba/serve-kit";

export function sendError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const output =
    error && typeof error === "object" && "output" in error
      ? error.output
      : undefined;
  const code =
    output && typeof output === "object" && "statusCode" in output
      ? output.statusCode
      : undefined;
  switch (code) {
    case 401:
      return new AdapterError(
        "REAUTH_REQUIRED",
        "WhatsApp no longer accepts this linked device; run login again",
      );
    case 403:
      return new AdapterError(
        "FORBIDDEN",
        "WhatsApp does not let this account do that",
      );
    case 404:
      return new AdapterError(
        "NOT_FOUND",
        "WhatsApp could not find the recipient or its encryption keys",
      );
    case 429:
      return new AdapterError(
        "RATE_LIMITED",
        "WhatsApp asked the adapter to slow down; try again later",
      );
    default:
      return new AdapterError(
        "INTERNAL",
        "The WhatsApp adapter failed; a write's outcome is unknown",
      );
  }
}
