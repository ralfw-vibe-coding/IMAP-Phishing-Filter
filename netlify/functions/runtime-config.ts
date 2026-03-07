import { getDashboardRuntimeConfig, setDashboardRuntimeConfig } from "../src/runtime.js";

type HandlerEvent = {
  httpMethod?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
};
type HandlerResponse = { statusCode: number; body: string; headers?: Record<string, string> };
type Handler = (event: HandlerEvent) => Promise<HandlerResponse>;

function json(statusCode: number, body: unknown): HandlerResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function parseBody(body: string | null | undefined): unknown {
  if (!body || body.trim().length === 0) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid JSON body: ${(error as Error).message}`);
  }
}

function hasValidDashboardPassword(event: HandlerEvent): { ok: boolean; reason?: string } {
  const configured = process.env.DASHBOARD_PASSWORD?.trim();
  if (!configured) return { ok: false, reason: "DASHBOARD_PASSWORD is not configured" };
  const headers = event.headers ?? {};
  const provided = headers["x-dashboard-password"] ?? headers["X-Dashboard-Password"];
  if (!provided || provided.trim() !== configured) return { ok: false, reason: "Unauthorized" };
  return { ok: true };
}

export const handler: Handler = async (event) => {
  try {
    const method = (event.httpMethod ?? "GET").toUpperCase();
    if (method === "GET") {
      const config = await getDashboardRuntimeConfig();
      return json(200, { config });
    }

    if (method === "PATCH") {
      const auth = hasValidDashboardPassword(event);
      if (!auth.ok) {
        return json(auth.reason === "Unauthorized" ? 401 : 500, {
          status: "error",
          message: auth.reason,
        });
      }
      const body = parseBody(event.body) as { logLevel?: unknown };
      const config = await setDashboardRuntimeConfig({ logLevel: body.logLevel as number });
      return json(200, { status: "ok", config });
    }

    return json(405, { status: "error", message: `Method ${method} not allowed` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { status: "error", message });
  }
};
