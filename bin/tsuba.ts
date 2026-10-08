/**
 * Every adapter in one executable (`bun run compile`):
 *
 *   tsuba <telegram|discord|slack|discord-user|imessage> <command>
 *
 * Each adapter's CLI reads its command from `process.argv`, so the adapter
 * name is taken out before that CLI is loaded.
 */
const ADAPTERS = {
  telegram: () => import("../adapters/telegram/src/cli"),
  discord: () => import("../adapters/discord/src/cli"),
  slack: () => import("../adapters/slack/src/cli"),
  "discord-user": () => import("../adapters/discord-user/src/cli"),
  imessage: () => import("../adapters/imessage/src/cli"),
};

function isAdapter(name: string | undefined): name is keyof typeof ADAPTERS {
  return name !== undefined && Object.hasOwn(ADAPTERS, name);
}

const adapter = process.argv[2];
if (!isAdapter(adapter)) {
  console.log(`usage: tsuba <${Object.keys(ADAPTERS).join("|")}> <command>`);
  process.exit(2);
}
process.argv.splice(2, 1);
await ADAPTERS[adapter]();

export {};
