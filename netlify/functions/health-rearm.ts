import { rearmHealthAlert } from "../src/health.js";

type HandlerResponse = { statusCode: number; body: string; headers?: Record<string, string> };
type HandlerEvent = { queryStringParameters?: Record<string, string | undefined> };
type Handler = (event: HandlerEvent) => Promise<HandlerResponse>;

function tokenIsValid(event: HandlerEvent): boolean {
  const required = process.env.HEALTH_REARM_TOKEN?.trim();
  if (!required) return true;
  const provided = event.queryStringParameters?.token?.trim();
  return Boolean(provided && provided === required);
}

export const handler: Handler = async (event) => {
  if (!tokenIsValid(event)) {
    return {
      statusCode: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "Forbidden",
    };
  }

  try {
    await rearmHealthAlert();
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: `
        <!doctype html>
        <html lang="en">
          <head><meta charset="utf-8"><title>Health alert re-armed</title></head>
          <body>
            <h1>Health alert enabled</h1>
            <p>You will receive health emails again.</p>
          </body>
        </html>
      `.trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      statusCode: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: `Error: ${message}`,
    };
  }
};
