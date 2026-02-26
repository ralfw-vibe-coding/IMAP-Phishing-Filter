import "dotenv/config";
import { z } from "zod";
import { buildImapAccountConfigFromEnvShape, startImapWatcher } from "./imap.js";

const envAccountsSchema = z.array(
  z.object({
    label: z.string().min(1),
    server: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
    folder: z.string().min(1),
  }),
);

function loadAccountsFromEnv() {
  const raw = process.env.IMAP_ACCOUNTS;
  if (!raw) {
    throw new Error("Missing IMAP_ACCOUNTS in environment (.env)");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(`IMAP_ACCOUNTS is not valid JSON: ${(err as Error).message}`);
  }

  const envAccounts = envAccountsSchema.parse(parsedJson);
  return envAccounts.map(buildImapAccountConfigFromEnvShape);
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`[main] starting at ${new Date().toISOString()}`);

  const accounts = loadAccountsFromEnv();
  // eslint-disable-next-line no-console
  console.log(`[main] loaded ${accounts.length} IMAP account(s): ${accounts.map((a) => a.label).join(", ")}`);

  const watchers = accounts.map((account) => startImapWatcher(account));
  await Promise.all(watchers.map((w) => w.ready));

  // eslint-disable-next-line no-console
  console.log("[main] all watchers connected at least once");

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[main] shutdown requested (${signal})`);
    await Promise.allSettled(watchers.map((w) => w.stop()));
    // eslint-disable-next-line no-console
    console.log("[main] shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[main] fatal error", err);
  process.exit(1);
});

