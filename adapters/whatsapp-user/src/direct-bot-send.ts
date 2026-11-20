import { AdapterError } from "@tsuba/serve-kit";
import {
  DirectBotSendUnavailableError,
  type WAMessage,
} from "@whiskeysockets/baileys";

export interface DirectBotSocket {
  canSendDirectBotText(jid: string): Promise<boolean>;
  sendDirectBotText(jid: string, text: string): Promise<WAMessage>;
}

export function directBotSendUnavailable(): AdapterError {
  return new AdapterError(
    "NOT_SUPPORTED",
    "WhatsApp direct bot text sending is unavailable; nothing was sent",
  );
}

export function bindDirectBotSend(
  ready: Promise<{ readonly socket: DirectBotSocket }>,
  disconnected: AbortSignal,
): DirectBotSocket {
  return {
    async canSendDirectBotText(jid) {
      const { socket } = await ready;
      return (
        !disconnected.aborted &&
        (await socket.canSendDirectBotText(jid)) &&
        !disconnected.aborted
      );
    },
    async sendDirectBotText(jid, text) {
      const { socket } = await ready;
      const available = await socket.canSendDirectBotText(jid);
      if (disconnected.aborted)
        throw new AdapterError(
          "BUSY",
          "WhatsApp is not connected yet; nothing was sent",
        );
      if (!available) throw directBotSendUnavailable();
      try {
        // The patched SDK returns the original prompt only after server acceptance.
        return await socket.sendDirectBotText(jid, text);
      } catch (error) {
        if (error instanceof DirectBotSendUnavailableError)
          throw directBotSendUnavailable();
        throw error;
      }
    },
  };
}
