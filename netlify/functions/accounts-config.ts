import {
  createDashboardAccount,
  deleteDashboardAccount,
  listDashboardAccounts,
  updateDashboardAccount,
} from "../src/runtime.js";

type HandlerEvent = {
  httpMethod?: string;
  body?: string | null;
  queryStringParameters?: Record<string, string | undefined>;
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

export const handler: Handler = async (event) => {
  try {
    const method = (event.httpMethod ?? "GET").toUpperCase();

    if (method === "GET") {
      const accounts = await listDashboardAccounts();
      return json(200, { accounts });
    }

    if (method === "POST") {
      const body = parseBody(event.body) as { account?: unknown };
      if (!body.account) return json(400, { status: "error", message: "Missing account" });
      const account = await createDashboardAccount(body.account);
      return json(201, { status: "ok", account });
    }

    if (method === "PATCH") {
      const body = parseBody(event.body) as { accountId?: string; account?: unknown };
      if (!body.accountId) return json(400, { status: "error", message: "Missing accountId" });
      if (!body.account) return json(400, { status: "error", message: "Missing account" });
      const account = await updateDashboardAccount(body.accountId, body.account);
      return json(200, { status: "ok", account });
    }

    if (method === "DELETE") {
      const accountId = event.queryStringParameters?.accountId;
      if (!accountId) return json(400, { status: "error", message: "Missing accountId" });
      await deleteDashboardAccount(accountId);
      return json(200, { status: "ok" });
    }

    return json(405, { status: "error", message: `Method ${method} not allowed` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { status: "error", message });
  }
};
