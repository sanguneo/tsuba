import { onTestFinished } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  addTransactionCapability,
  type BinaryNode,
  DEFAULT_CONNECTION_CONFIG,
  encodeBigEndian,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  jidDecode,
  type makeWASocket,
  useMultiFileAuthState,
} from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys";
import { makeLibSignalRepository } from "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib/Signal/libsignal";

const SELF = "100000000001:7@s.whatsapp.net";
export const SELF_LID = "800000000001@lid";
export const TARGET_LID = "900000000001@lid";

function node(tag: string, content: BinaryNode["content"]): BinaryNode {
  return { tag, attrs: {}, ...(content === undefined ? {} : { content }) };
}

/**
 * Run the installed send/relay, key parser and Signal implementation. Substitute
 * only the lower socket constructors in memory: no WebSocket can be constructed.
 * A separate module instance avoids globally mocking other suites' SDK imports.
 */
export async function setupSdkSend(lid: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "tsuba-wa-signal-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const entry = await realpath(
    Bun.resolveSync(
      "../adapters/whatsapp-user/node_modules/@whiskeysockets/baileys/lib/Socket/messages-send.js",
      import.meta.dir,
    ),
  );
  const source = (await Bun.file(entry).text())
    .replace(
      "import { makeGroupsSocket } from './groups.js';",
      "const makeGroupsSocket = config => config.syntheticTransport;",
    )
    .replace(
      "import { makeNewsletterSocket } from './newsletter.js';",
      "const makeNewsletterSocket = socket => socket;",
    )
    .replace(
      /from (['"])([^'"]+)\1/g,
      (_match, quote: string, specifier: string) =>
        `from ${quote}file://${Bun.resolveSync(specifier, dirname(entry))}${quote}`,
    );
  const sdk: {
    makeMessagesSocket(
      config: Parameters<typeof makeWASocket>[0],
    ): Pick<ReturnType<typeof makeWASocket>, "sendMessage">;
  } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const logger = DEFAULT_CONNECTION_CONFIG.logger.child({});
  logger.level = "silent";
  const { state } = await useMultiFileAuthState(dir);
  state.creds.me = { id: SELF, ...(lid === undefined ? {} : { lid }) };
  state.creds.account = {
    details: Buffer.alloc(0),
    accountSignatureKey: Buffer.alloc(32),
    accountSignature: Buffer.alloc(64),
    deviceSignature: Buffer.alloc(64),
  };
  const auth = {
    creds: state.creds,
    keys: addTransactionCapability(
      state.keys,
      logger,
      DEFAULT_CONNECTION_CONFIG.transactionOpts,
    ),
  };
  const peers = new Map<string, ReturnType<typeof makeLibSignalRepository>>();
  const queryJids: string[] = [];
  const stanzas: BinaryNode[] = [];
  const config = {
    ...DEFAULT_CONNECTION_CONFIG,
    logger,
    emitOwnEvents: false,
    syntheticTransport: {
      user: state.creds.me,
      ev: { on() {}, off() {}, emit() {} },
      authState: auth,
      signalRepository: makeLibSignalRepository(auth),
      async executeUSyncQuery(query: {
        parseUSyncQueryResult(result: BinaryNode): unknown;
      }) {
        return query.parseUSyncQueryResult(
          node("iq", [node("usync", [node("list", [])])]),
        );
      },
      async query(request: BinaryNode) {
        const users = getBinaryNodeChildren(
          getBinaryNodeChild(request, "key"),
          "user",
        );
        const keys: BinaryNode[] = [];
        for (const user of users) {
          const jid = user.attrs.jid;
          const address = jidDecode(jid);
          if (
            !jid ||
            !address ||
            !["lid", "s.whatsapp.net"].includes(address.server)
          )
            throw Object.assign(new Error("Synthetic key query refusal"), {
              output: { statusCode: 404 },
            });
          queryJids.push(jid);
          const peerDir = join(dir, address.user);
          await mkdir(peerDir, { recursive: true });
          const peer = await useMultiFileAuthState(peerDir);
          const creds = peer.state.creds;
          peers.set(jid, makeLibSignalRepository(peer.state));
          keys.push({
            tag: "user",
            attrs: { jid },
            content: [
              node("registration", encodeBigEndian(creds.registrationId, 4)),
              node("identity", creds.signedIdentityKey.public),
              node("skey", [
                node("id", encodeBigEndian(creds.signedPreKey.keyId, 3)),
                node("value", creds.signedPreKey.keyPair.public),
                node("signature", creds.signedPreKey.signature),
              ]),
            ],
          });
        }
        return node("iq", [node("list", keys)]);
      },
      async sendNode(stanza: BinaryNode) {
        stanzas.push(stanza);
      },
    },
  };
  return {
    socket: sdk.makeMessagesSocket(config),
    queryJids,
    stanzas,
    peers,
  };
}
