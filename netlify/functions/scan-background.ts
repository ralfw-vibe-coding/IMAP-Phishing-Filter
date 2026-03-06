import { runBackgroundScan } from "../src/runtime.js";

type HandlerResponse = { statusCode: number; body: string };
type Handler = () => Promise<HandlerResponse>;

export const handler: Handler = async () => {
  try {
    const result = await runBackgroundScan();
    if (result.status === "busy") {
      return {
        statusCode: 202,
        body: JSON.stringify({ status: "busy" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ status: "error", message }),
    };
  }
};
