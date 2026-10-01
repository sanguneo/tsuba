import { AdapterError } from "@tsuba/serve-kit";

const BASE = "https://slack.com/api/";

/** Slack's `error` strings, sorted by what they say changed: nothing, for each of these. */
const REAUTH = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
]);
const FORBIDDEN = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "cant_update_message",
  "cant_delete_message",
  "edit_window_closed",
  "not_in_channel",
  "is_archived",
  "too_many_reactions",
  "access_denied",
  "ekm_access_denied",
  "team_access_not_granted",
  "cannot_reply_to_message",
]);
const NOT_FOUND = new Set([
  "channel_not_found",
  "message_not_found",
  "thread_not_found",
  "file_not_found",
  "file_deleted",
  "user_not_found",
]);
const INVALID = new Set([
  "invalid_name",
  "invalid_ts_latest",
  "invalid_ts_oldest",
  "invalid_cursor",
  "invalid_arguments",
  "msg_too_long",
  "no_text",
  "invalid_timestamp",
  "bad_timestamp",
]);
const IGNORED_ON_REACT = new Set(["already_reacted", "no_reaction"]);

export function slackError(code: string): AdapterError {
  if (REAUTH.has(code))
    return new AdapterError(
      "REAUTH_REQUIRED",
      "Slack no longer accepts this token; install the app again where the adapter runs",
    );
  if (code === "ratelimited")
    return new AdapterError(
      "RATE_LIMITED",
      "Slack asked the adapter to slow down",
    );
  if (FORBIDDEN.has(code))
    return new AdapterError(
      "FORBIDDEN",
      "Slack does not let this account do that here",
    );
  if (NOT_FOUND.has(code))
    return new AdapterError(
      "NOT_FOUND",
      "No such Slack conversation, message or file",
    );
  if (INVALID.has(code))
    return new AdapterError(
      "INVALID_REQUEST",
      "Slack refused the request as it was",
    );
  return new AdapterError("INTERNAL", "The Slack adapter failed");
}

export type SlackCall = <T extends object>(
  method: string,
  params?: Record<string, string | number | boolean | undefined>,
  options?: { tolerate?: ReadonlySet<string> },
) => Promise<T>;

/**
 * One Web API method call, form-encoded with the token in the header (never
 * in the body or address). A refusal Slack states becomes the code that says
 * nothing changed; a 429 is RATE_LIMITED; anything else stays INTERNAL.
 */
export function slackApi(
  token: string,
  fetcher: typeof fetch = fetch,
): SlackCall {
  return async (method, params = {}, options = {}) => {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(params))
      if (value !== undefined) body.set(name, String(value));
    let response: Response;
    try {
      response = await fetcher(BASE + method, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch {
      throw new AdapterError("INTERNAL", "Slack could not be reached");
    }
    if (response.status === 429)
      throw new AdapterError(
        "RATE_LIMITED",
        "Slack asked the adapter to slow down",
      );
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      throw new AdapterError(
        "INTERNAL",
        "Slack answered something that is not JSON",
      );
    }
    if (!answer || typeof answer !== "object" || !("ok" in answer))
      throw new AdapterError("INTERNAL", "Slack answered something unexpected");
    if (answer.ok !== true) {
      const code =
        "error" in answer && typeof answer.error === "string"
          ? answer.error
          : "";
      if (options.tolerate?.has(code)) return answer as never;
      throw slackError(code);
    }
    return answer as never;
  };
}

export const REACTION_NOOPS = IGNORED_ON_REACT;
