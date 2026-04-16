import { jsonResponse } from "../common/http/json.js";

export interface RouteContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  readJson(): Promise<Record<string, unknown>>;
}

export interface RouteDef {
  method: string;
  path: string;
  handle(context: RouteContext): Promise<Response> | Response;
}

interface CompiledRoute {
  method: string;
  match(pathname: string): Record<string, string> | null;
  handle(context: RouteContext): Promise<Response> | Response;
}

interface JsonRouteOptions {
  status?: number;
  getErrorStatus?: (error: unknown) => number;
}

type RouteSegment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string; integerOnly: boolean };

function normalizePath(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new Error(`Route path must start with '/': ${path}`);
  }
  if (path === "/") return [];
  return path.slice(1).split("/");
}

function parseSegment(segment: string): RouteSegment {
  const integerParamMatch = /^:([A-Za-z0-9_]+)\(int\)$/.exec(segment);
  if (integerParamMatch) {
    return { kind: "param", name: integerParamMatch[1] ?? "", integerOnly: true };
  }

  const paramMatch = /^:([A-Za-z0-9_]+)$/.exec(segment);
  if (paramMatch) {
    return { kind: "param", name: paramMatch[1] ?? "", integerOnly: false };
  }

  return { kind: "literal", value: segment };
}

function compilePath(path: string): (pathname: string) => Record<string, string> | null {
  const routeSegments = normalizePath(path).map(parseSegment);

  return (pathname: string) => {
    const requestSegments = normalizePath(pathname);
    if (routeSegments.length !== requestSegments.length) {
      return null;
    }

    const params: Record<string, string> = {};

    for (let index = 0; index < routeSegments.length; index += 1) {
      const routeSegment = routeSegments[index];
      const requestSegment = requestSegments[index];
      if (!routeSegment || requestSegment == null) {
        return null;
      }

      if (routeSegment.kind === "literal") {
        if (routeSegment.value !== requestSegment) {
          return null;
        }
        continue;
      }

      if (routeSegment.integerOnly && !/^\d+$/.test(requestSegment)) {
        return null;
      }

      params[routeSegment.name] = decodeURIComponent(requestSegment);
    }

    return params;
  };
}

export function route(method: string, path: string, handle: RouteDef["handle"]): RouteDef {
  return { method: method.toUpperCase(), path, handle };
}

export function jsonRoute(
  method: string,
  path: string,
  handle: (context: RouteContext) => Promise<unknown> | unknown,
  options: JsonRouteOptions = {},
): RouteDef {
  return route(method, path, async (context) => {
    try {
      return jsonResponse(options.status ?? 200, await handle(context));
    } catch (error) {
      return jsonResponse(options.getErrorStatus?.(error) ?? 500, { error: getErrorMessage(error) });
    }
  });
}

export function createRouteDispatcher(routes: RouteDef[]) {
  const compiledRoutes: CompiledRoute[] = routes.map((definition) => ({
    method: definition.method.toUpperCase(),
    match: compilePath(definition.path),
    handle: definition.handle,
  }));

  return async function dispatch(context: Omit<RouteContext, "params">): Promise<Response | null> {
    for (const definition of compiledRoutes) {
      if (definition.method !== context.request.method.toUpperCase()) {
        continue;
      }

      const params = definition.match(context.url.pathname);
      if (!params) {
        continue;
      }

      return definition.handle({ ...context, params });
    }

    return null;
  };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
