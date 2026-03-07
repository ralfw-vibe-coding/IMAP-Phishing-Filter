import { runHealthCheck } from "../src/health.js";

type HandlerResponse = { statusCode: number; body: string; headers?: Record<string, string> };
type Handler = () => Promise<HandlerResponse>;

export const handler: Handler = async () => {
  const at = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[health-run] manual trigger at=${at}`);

  try {
    const result = await runHealthCheck();
    return {
      statusCode: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        status: "ok",
        checkedAtIso: result.checkedAtIso,
        state: result.report.state,
        reason: result.report.reason,
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[health-run] error at=${at} message=${message}`);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ status: "error", message }),
    };
  }
};
