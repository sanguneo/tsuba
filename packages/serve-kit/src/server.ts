import contract from "../../../contract/openapi.json";
import { authorized, checkToken } from "./auth";
import { type Capabilities, capabilityRevision } from "./capabilities";
import { failure, ok } from "./envelope";

export const CONTRACT_VERSION: string = contract.info.version;

export interface AdapterOptions {
  token: string;
  capabilities: Capabilities;
}

interface Route {
  method: "GET" | "POST";
  auth: boolean;
  answer: (request: Request) => Response | Promise<Response>;
}

export function createHandler(options: AdapterOptions) {
  const token = checkToken(options.token);
  const capabilities = {
    ...options.capabilities,
    revision: capabilityRevision(options.capabilities),
  };
  const routes: Readonly<Record<string, Route>> = {
    "/health": { method: "GET", auth: false, answer: () => ok({}) },
    "/capabilities": {
      method: "GET",
      auth: true,
      answer: () =>
        ok({ contract: { version: CONTRACT_VERSION }, ...capabilities }),
    },
  };

  async function handle(request: Request): Promise<Response> {
    const route = routes[new URL(request.url).pathname];
    // An unknown path is refused like a protected one, so an unauthenticated
    // caller cannot map which routes exist.
    if (route?.auth !== false && !authorized(request, token))
      return failure("UNAUTHORIZED", "A valid bearer token is required");
    if (!route) return failure("NOT_FOUND", "No such route");
    if (request.method !== route.method)
      return failure("METHOD_NOT_ALLOWED", `Use ${route.method}`, {
        allow: route.method,
      });
    return route.answer(request);
  }

  return { handle, routes: Object.keys(routes) };
}

export function serve(
  options: AdapterOptions & { port: number; hostname?: string },
) {
  const { handle } = createHandler(options);
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    fetch: handle,
  });
}
