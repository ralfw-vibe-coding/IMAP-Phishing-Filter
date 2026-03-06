import { isBackgroundBusy, triggerBackgroundScan } from "../src/runtime.js";

type HandlerResponse = { statusCode: number; body: string };
type Handler = () => Promise<HandlerResponse>;

export const config = {
  // every 60 seconds
  schedule: "* * * * *",
};

export const handler: Handler = async () => {
  const at = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[scheduled] tick at=${at}`);

  try {
    const busy = await isBackgroundBusy();
    if (busy) {
      // eslint-disable-next-line no-console
      console.log(`[scheduled] skip reason=background_busy at=${at}`);
      return {
        statusCode: 202,
        body: JSON.stringify({ status: "skipped", reason: "background_busy" }),
      };
    }

    const baseUrl = process.env.URL ?? process.env.DEPLOY_URL;
    if (!baseUrl) {
      // eslint-disable-next-line no-console
      console.error(`[scheduled] error reason=missing_base_url at=${at}`);
      return {
        statusCode: 500,
        body: JSON.stringify({ status: "error", reason: "missing_base_url" }),
      };
    }

    await triggerBackgroundScan(baseUrl);
    // eslint-disable-next-line no-console
    console.log(`[scheduled] triggered target=scan-background at=${at}`);
    return {
      statusCode: 202,
      body: JSON.stringify({ status: "triggered" }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[scheduled] error at=${at} message=${message}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ status: "error", message }),
    };
  }
};
