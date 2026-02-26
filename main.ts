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

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean env ${name}="${raw}" (use true/false)`);
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid integer env ${name}="${raw}"`);
  return n;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`[main] starting at ${new Date().toISOString()}`);

  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error("[main] unhandledRejection", reason);
  });

  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error("[main] uncaughtException", err);
  });

  const accounts = loadAccountsFromEnv();
  // eslint-disable-next-line no-console
  console.log(
    `[main] loaded ${accounts.length} IMAP account(s): ${accounts.map((a) => a.label).join(", ")}`,
  );

  const scanOnStart = envFlag("IMAP_SCAN_ON_START", false);
  const scanMax = Math.min(10, envInt("IMAP_SCAN_ON_START_MAX", 10));
  // eslint-disable-next-line no-console
  console.log(`[main] IMAP_SCAN_ON_START=${scanOnStart} IMAP_SCAN_ON_START_MAX=${scanMax}`);

  const watchers = accounts.map((account) =>
    startImapWatcher(account, { scanOnStart, scanOnStartMax: scanMax }),
  );
  await Promise.all(watchers.map((w) => w.ready));

  // eslint-disable-next-line no-console
  console.log("[main] all watchers connected at least once");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      // eslint-disable-next-line no-console
      console.log(`[main] shutdown already in progress (${signal}), forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[main] shutdown requested (${signal})`);
    const forceTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.log("[main] shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    await Promise.allSettled(watchers.map((w) => w.stop()));
    clearTimeout(forceTimer);
    // eslint-disable-next-line no-console
    console.log("[main] shutdown complete");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[main] fatal error", err);
  process.exit(1);
});
