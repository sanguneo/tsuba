import { expect, test } from "bun:test";
import {
  type Capabilities,
  capabilityRevision,
  createHandler,
  type ErrorEnvelope,
  type ProviderIcon,
  serve,
} from "../packages/serve-kit/src/index";
import { schema, TOKEN } from "./fixtures";

const capabilities: Capabilities = {
  provider: { id: "example", name: "Example" },
  account: { kind: "bot" },
  adapter: { name: "synthetic", version: "1" },
  features: {},
};
type CapabilityAnswer = Capabilities & { revision: string };
const bearer = { authorization: `Bearer ${TOKEN}` };
const svg = (text: string): ProviderIcon => ({
  bytes: new TextEncoder().encode(text),
  type: "image/svg+xml",
});
const safe =
  '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';

for (const type of ["image/svg+xml", "image/png", "image/webp"] as const) {
  test(`/icon serves ${type} with inert private headers over real HTTP`, async () => {
    const icon =
      type === "image/svg+xml"
        ? svg(safe)
        : { bytes: new Uint8Array([1, 2, 3]), type };
    const server = serve({ token: TOKEN, capabilities, icon, port: 0 });
    try {
      const url = new URL("/icon?v=opaque", server.url);
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: bearer });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe(
        "private, max-age=86400",
      );
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
        ...icon.bytes,
      ]);
      const declaration = (await (
        await fetch(new URL("/capabilities", server.url), { headers: bearer })
      ).json()) as CapabilityAnswer;
      expect(schema("Capabilities")(declaration)).toBe(true);
      expect(declaration.provider.icon).toMatch(/^[0-9a-f]{16}$/);
      const wrongMethod = await fetch(url, { method: "POST", headers: bearer });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET");
    } finally {
      await server.stop(true);
    }
  });
}

test("without icon bytes, /icon is NOT_FOUND and provider.icon is absent", async () => {
  const { handle } = createHandler({
    token: TOKEN,
    capabilities: {
      ...capabilities,
      provider: { ...capabilities.provider, icon: "stale" },
    },
  });
  expect((await handle(new Request("http://adapter/icon"))).status).toBe(401);
  const response = await handle(
    new Request("http://adapter/icon", { headers: bearer }),
  );
  expect(response.status).toBe(404);
  expect(((await response.json()) as ErrorEnvelope).error.code).toBe(
    "NOT_FOUND",
  );
  const declaration = (await (
    await handle(
      new Request("http://adapter/capabilities", { headers: bearer }),
    )
  ).json()) as CapabilityAnswer;
  expect(declaration.provider).not.toHaveProperty("icon");
});

test("icon version and capability revision follow the snapshot of the bytes", async () => {
  async function declaration(icon: ProviderIcon) {
    const { handle } = createHandler({ token: TOKEN, capabilities, icon });
    const original = icon.bytes.slice();
    icon.bytes.fill(0);
    const image = await handle(
      new Request("http://adapter/icon", { headers: bearer }),
    );
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(original);
    return (await (
      await handle(
        new Request("http://adapter/capabilities", { headers: bearer }),
      )
    ).json()) as CapabilityAnswer;
  }
  const first = await declaration(svg(safe));
  const same = await declaration(svg(safe));
  const changed = await declaration(svg(safe.replace("h1", "h2")));
  expect(first.provider.icon).toBe(same.provider.icon);
  expect(first.provider.icon).not.toBe(changed.provider.icon);
  expect(first.revision).not.toBe(changed.revision);
  expect(first.revision).toBe(
    capabilityRevision({ ...capabilities, provider: first.provider }),
  );
});

test("same-document SVG references and namespace declarations are accepted", () => {
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities,
      icon: svg(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="local"/></defs><use href="#local" xlink:href="#local" style="fill:url(\'#local\')"/></svg>',
      ),
    }),
  ).not.toThrow();
});

for (const [name, content] of [
  ["script", "<script>alert(1)</script>"],
  ["namespaced script", '<s:script xmlns:s="http://www.w3.org/2000/svg"/>'],
  ["event handler", '<path onload="alert(1)"/>'],
  ["mixed-case event handler", '<path ONCLICK="alert(1)"/>'],
  ["foreignObject", "<foreignObject><div/></foreignObject>"],
  ["DOCTYPE", "<!DOCTYPE svg>"],
  ["ENTITY", '<!ENTITY remote SYSTEM "https://example.invalid/">'],
  ["href", '<use href="https://example.invalid/image.svg#local"/>'],
  ["xlink:href", '<use xlink:href="data:image/svg+xml,unsafe"/>'],
  ["relative href", '<use href="other.svg#local"/>'],
  [
    "external base",
    '<g xml:base="https://example.invalid/"><use href="#local"/></g>',
  ],
  ["url", '<path fill="url(https://example.invalid/image.svg)"/>'],
  ["CSS import", '<style>@import "https://example.invalid/style.css";</style>'],
  ["entity-obfuscated href", '<use href="&#104;ttps://example.invalid/"/>'],
  [
    "CSS escape",
    "<style>path { fill: u\\72l(https://example.invalid/); }</style>",
  ],
  ["CSS comment", '<style>@im/**/port "https://example.invalid/";</style>'],
  [
    "stylesheet instruction",
    '<?xml-stylesheet href="https://example.invalid/"?>',
  ],
  [
    "animated href",
    '<animate attributeName="href" to="https://example.invalid/"/>',
  ],
]) {
  test(`construction refuses SVG ${name}`, () => {
    expect(() =>
      createHandler({
        token: TOKEN,
        capabilities,
        icon: svg(`<svg>${content}</svg>`),
      }),
    ).toThrow();
  });
}

test("construction refuses icons above 64 KiB, but accepts the boundary", () => {
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities,
      icon: { bytes: new Uint8Array(65537), type: "image/png" },
    }),
  ).toThrow();
  expect(() =>
    createHandler({
      token: TOKEN,
      capabilities,
      icon: { bytes: new Uint8Array(65536), type: "image/png" },
    }),
  ).not.toThrow();
});

for (const adapter of ["telegram", "slack", "discord", "discord-user"]) {
  test(`${adapter}'s shipped SVG passes construction`, async () => {
    const bytes = new Uint8Array(
      await Bun.file(
        new URL(`../adapters/${adapter}/icon.svg`, import.meta.url),
      ).arrayBuffer(),
    );
    expect(() =>
      createHandler({
        token: TOKEN,
        capabilities,
        icon: { bytes, type: "image/svg+xml" },
      }),
    ).not.toThrow();
  });
}
