import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Resolve the SDK owned by this workspace, not a second root dependency.
import {
  DEFAULT_CONNECTION_CONFIG,
  generateLoginNode,
  generateRegistrationNode,
  proto,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { openBaileys } from "../adapters/whatsapp-user/src/baileys";
import { bounded, deferred } from "./harness/barriers";

test("pairing requests desktop full sync and reconnect keeps a compatible web payload", async () => {
  const authDir = await mkdtemp(join(tmpdir(), "tsuba-wa-payload-"));
  const captured =
    deferred<
      Parameters<
        NonNullable<Parameters<typeof openBaileys>[0]["makeSocket"]>
      >[0]
    >();
  const socket = openBaileys({
    authDir,
    makeSocket(config) {
      captured.resolve(config);
      return {
        ev: { on() {} },
        profilePictureUrl: async () => undefined,
        sendMessage: async () => undefined,
        updateMediaMessage: async () => {
          throw new Error("Unexpected media refresh");
        },
        groupFetchAllParticipating: async () => ({}),
        end() {},
      };
    },
  });
  onTestFinished(async () => {
    await socket.close();
    await rm(authDir, { recursive: true, force: true });
  });
  const config = {
    ...DEFAULT_CONNECTION_CONFIG,
    ...(await bounded(captured.promise, "adapter socket config")),
  };
  // The real installed SDK encodes the pairing payload; no connection is made.
  const registration = generateRegistrationNode(config.auth.creds, config);
  const props = registration.devicePairingData?.deviceProps;
  if (!props) throw new Error("Missing encoded companion device properties");
  const device = proto.DeviceProps.decode(props);
  expect({
    platform: device.platformType,
    fullSync: device.requireFullSync,
  }).toEqual({
    platform: proto.DeviceProps.PlatformType.DESKTOP,
    fullSync: true,
  });
  // WIN32/DARWIN + WEB are rejected before QR in upstream #2677/#2880.
  const login = generateLoginNode("100000000001:1@s.whatsapp.net", config);
  expect(registration.webInfo?.webSubPlatform).toBe(
    proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER,
  );
  expect(login.webInfo?.webSubPlatform).toBe(
    proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER,
  );
  for (const syncType of [0, 2, 3, 4])
    expect(config.shouldSyncHistoryMessage({ syncType })).toBe(true);
});
