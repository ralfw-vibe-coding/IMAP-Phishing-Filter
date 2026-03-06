import { getScanStatus } from "../src/runtime.js";

type HandlerResponse = { statusCode: number; body: string; headers?: Record<string, string> };
type Handler = () => Promise<HandlerResponse>;

export const handler: Handler = async () => {
  try {
    const status = await getScanStatus();
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(status),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ status: "error", message }),
    };
  }
};
