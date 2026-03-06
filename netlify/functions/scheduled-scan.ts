import { isBackgroundBusy, triggerBackgroundScan } from "../src/runtime.js";

type HandlerResponse = { statusCode: number; body: string };
type Handler = () => Promise<HandlerResponse>;

export const config = {
  // every 60 seconds
  schedule: "* * * * *",
};

export const handler: Handler = async () => {
  try {
    const busy = await isBackgroundBusy();
    if (busy) {
      return {
        statusCode: 202,
        body: JSON.stringify({ status: "skipped", reason: "background_busy" }),
      };
    }

    const baseUrl = process.env.URL ?? process.env.DEPLOY_URL;
    if (!baseUrl) {
      return {
        statusCode: 500,
        body: JSON.stringify({ status: "error", reason: "missing_base_url" }),
      };
    }

    await triggerBackgroundScan(baseUrl);
    return {
      statusCode: 202,
      body: JSON.stringify({ status: "triggered" }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ status: "error", message }),
    };
  }
};
