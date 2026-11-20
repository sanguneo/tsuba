import { expect, test } from "bun:test";
import { getBinaryNodeChild } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { collection, muteEndTime } from "./whatsapp-user-wasa-patches";
import { type Mode, reconnect } from "./whatsapp-user-wasa-reconnect-fixture";

test.each([
  { mode: "active", queries: 1, ready: true, mute: [muteEndTime] },
  { mode: "snapshot", queries: 1, ready: true, mute: [muteEndTime] },
  { mode: "inactive", queries: 1, ready: false, mute: [muteEndTime] },
  { mode: "fresh", queries: 0, ready: false, mute: [] },
  { mode: "stale", queries: 0, ready: false, mute: [] },
  { mode: "no-key", queries: 0, ready: false, mute: [] },
  { mode: "more", queries: 1, ready: false, mute: [] },
  { mode: "absent", queries: 1, ready: false, mute: [] },
  { mode: "empty", queries: 1, ready: false, mute: [] },
  { mode: "refused", queries: 1, ready: false, mute: [] },
  { mode: "tampered", queries: 1, ready: false, mute: [] },
] satisfies readonly {
  mode: Mode;
  queries: number;
  ready: boolean;
  mute: readonly number[];
}[])(
  "reconnect without history: $mode projection over loopback GET /rooms",
  async ({ mode, queries, ready, mute }) => {
    const adapter = await reconnect(mode);
    expect(await adapter.features()).toMatchObject({ "messages.send": false });
    await adapter.finishOfflineWindow();
    const features = await adapter.features();
    if (ready) {
      expect(Object.hasOwn(features, "messages.send")).toBe(false);
      expect(features).toMatchObject({
        "messages.reply": false,
        "attachments.send": false,
      });
    } else expect(features).toMatchObject({ "messages.send": false });
    expect(adapter.requests).toHaveLength(queries);
    expect(adapter.muteUpdates).toEqual(mute);
    for (const request of adapter.requests) {
      const sync = getBinaryNodeChild(request, "sync");
      expect(sync?.content).toEqual([
        {
          tag: "collection",
          attrs: { name: collection, version: "0", return_snapshot: "true" },
        },
      ]);
    }
    if (ready || mode === "tampered" || mode === "more") {
      await adapter.notifyCollection();
      const followUp = adapter.requests[1];
      expect(
        getBinaryNodeChild(getBinaryNodeChild(followUp, "sync"), "collection")
          ?.attrs.version,
      ).toBe(ready ? "2" : "0");
      expect(adapter.muteUpdates).toEqual(mute);
    }
  },
);
