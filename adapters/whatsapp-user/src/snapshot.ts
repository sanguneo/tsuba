/** Versioned, account-local cache. Message bytes use Baileys' protobuf codec. */
export interface StoreSnapshot {
  readonly version: 1;
  readonly chats: {
    id: string;
    name: string | null;
    at: number | null;
    unread: number | null;
  }[];
  readonly names: {
    id: string;
    name: string | null;
    notify: string | null;
  }[];
  readonly aliases: { id: string; linked: string[] }[];
  readonly pushNames: { id: string; name: string; at: number }[];
  readonly subjects: { id: string; subject: string }[];
  readonly messages: { data: string; editedAt: number | null }[];
}

export class StoreFileError extends Error {
  constructor() {
    super("WhatsApp room cache could not be read or saved");
    this.name = "StoreFileError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function number(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function rows(
  value: unknown,
  check: (row: Record<string, unknown>) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.every((row: unknown) => record(row) && check(row))
  );
}

function valid(value: unknown): value is StoreSnapshot {
  return (
    record(value) &&
    value.version === 1 &&
    rows(
      value.chats,
      (row) =>
        typeof row.id === "string" &&
        text(row.name) &&
        number(row.at) &&
        number(row.unread),
    ) &&
    rows(
      value.names,
      (row) => typeof row.id === "string" && text(row.name) && text(row.notify),
    ) &&
    rows(
      value.aliases,
      (row) =>
        typeof row.id === "string" &&
        Array.isArray(row.linked) &&
        row.linked.every((id: unknown) => typeof id === "string"),
    ) &&
    rows(
      value.pushNames,
      (row) =>
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.at === "number" &&
        Number.isFinite(row.at),
    ) &&
    rows(
      value.subjects,
      (row) => typeof row.id === "string" && typeof row.subject === "string",
    ) &&
    rows(
      value.messages,
      (row) => typeof row.data === "string" && number(row.editedAt),
    )
  );
}

export function parseSnapshot(json: string): StoreSnapshot {
  const value: unknown = JSON.parse(json);
  if (!valid(value)) throw new StoreFileError();
  return value;
}
