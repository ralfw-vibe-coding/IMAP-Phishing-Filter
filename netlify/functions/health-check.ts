import { runHealthCheck } from "../src/health.js";

type HandlerResponse = { statusCode: number; body: string; headers?: Record<string, string> };
type Handler = () => Promise<HandlerResponse>;

export const config = {
  // every 8 hours (at minute 0)
  schedule: "0 */8 * * *",
};

export const handler: Handler = async () => {
  const at = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[health] tick at=${at}`);

  try {
    const result = await runHealthCheck();
    // eslint-disable-next-line no-console
    console.log(`[health] mail_sent at=${at} state=${result.report.state} reason="${result.report.reason}"`);
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
    console.error(`[health] error at=${at} message=${message}`);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ status: "error", message }),
    };
  }
};
