// discord.js's validator (@sapphire/shapeshift) names Node's `util.InspectOptionsStylized`,
// which @types/node 26 no longer exports. It is the inspect options plus `stylize`.
import type { InspectOptions } from "node:util";

declare module "util" {
  interface InspectOptionsStylized extends InspectOptions {
    stylize(text: string, styleType: string): string;
  }
}
