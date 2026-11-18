import { proto } from "@whiskeysockets/baileys";
import type { WaMessageLike, WaTime } from "./types";

const { SERVER_ACK, DELIVERY_ACK, READ, PLAYED } = proto.WebMessageInfo.Status;

function observed(time: WaTime): boolean {
  const value = typeof time === "object" && time ? time.toNumber() : time;
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Aggregate only confirmed evidence; one recipient suffices, including groups. */
export function confirmedStatus(
  raw: Pick<WaMessageLike, "status" | "userReceipt">,
): number {
  let status =
    raw.status === READ || raw.status === PLAYED
      ? READ
      : raw.status === DELIVERY_ACK || raw.status === SERVER_ACK
        ? raw.status
        : 0;
  for (const receipt of raw.userReceipt ?? []) {
    if (observed(receipt.readTimestamp) || observed(receipt.playedTimestamp))
      status = READ;
    else if (observed(receipt.receiptTimestamp))
      status = Math.max(status, DELIVERY_ACK);
  }
  return status;
}

export function deliveryStatus(raw: WaMessageLike) {
  if (!raw.key.fromMe) return undefined;
  switch (confirmedStatus(raw)) {
    case SERVER_ACK:
      return "sent";
    case DELIVERY_ACK:
      return "delivered";
    case READ:
      return "read";
    default:
      return undefined;
  }
}
