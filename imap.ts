import { ImapFlow, type ListTreeResponse } from "imapflow";
import { runScan, type AccountConfig, type ScanLogger, type StateProvider } from "./packages/body/src/index.js";
import { ImapflowMailboxProvider, OpenAiPhishingProvider } from "./packages/providers-node/src/index.js";

export type ImapAccountConfig = {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  folder: string;
};

type StopHandle = { stop(): Promise<void> };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const ANSI = {
  red: "\u001b[31m",
  reset: "\u001b[0m",
} as const;

function log(accountLabel: string, message: string, extra?: unknown) {
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`[${now()}] [${accountLabel}] ${message}`, extra);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[${now()}] [${accountLabel}] ${message}`);
}

function logPhishing(accountLabel: string, message: string) {
  // eslint-disable-next-line no-console
  console.log(`${ANSI.red}[${now()}] [${accountLabel}] ${message}${ANSI.reset}`);
}

class WatcherStateProvider implements StateProvider {
  private lastSeenUid: number | null = null;

  async getLastSeenUid(_accountId: string): Promise<number | null> {
    return this.lastSeenUid;
  }

  async setLastSeenUid(_accountId: string, uid: number): Promise<void> {
    this.lastSeenUid = uid;
  }
}

function toAccountConfig(account: ImapAccountConfig): AccountConfig {
  return {
    id: `${account.user}@${account.host}:${account.port}|${account.folder}`,
    label: account.label,
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.user,
    password: account.password,
    folder: account.folder,
    phishingTreatment: "flag",
  };
}

export function startImapWatcher(
  account: ImapAccountConfig,
  opts?: { scanOnStart?: boolean; scanOnStartMax?: number },
): StopHandle & { ready: Promise<void> } {
  const scanOnStart = opts?.scanOnStart ?? false;
  const scanOnStartMax = Math.max(1, Math.min(10, opts?.scanOnStartMax ?? 10));
  const pollingSeconds = 60;
  let stopped = false;
  let runPromise: Promise<void> | null = null;

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const mailbox = new ImapflowMailboxProvider();
  const ai = new OpenAiPhishingProvider();
  const state = new WatcherStateProvider();
  const accountConfig = toAccountConfig(account);

  const logger: ScanLogger = {
    info: (message, extra) => log(account.label, message, extra),
    warn: (message) => {
      if (message.includes("PHISHING")) {
        logPhishing(account.label, message);
      } else {
        log(account.label, message);
      }
    },
    error: (message, extra) => log(account.label, message, extra),
  };

  const runScanSince = async () => {
    await runScan(
      {
        account: accountConfig,
        kind: "since",
        maxMessages: 25,
      },
      {
        mailbox,
        ai,
        state,
        logger,
      },
    );
  };

  const runScanLatestOnStart = async () => {
    await runScan(
      {
        account: accountConfig,
        kind: "latest",
        latestN: scanOnStartMax,
      },
      {
        mailbox,
        ai,
        state,
        logger,
      },
    );
  };

  const run = async () => {
    let attempt = 0;
    let started = false;

    while (!stopped) {
      attempt += 1;
      const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, attempt - 1));

      try {
        if (!started) {
          log(account.label, `Watcher bootstrap (scanOnStart=${scanOnStart}, max=${scanOnStartMax})`);
          if (scanOnStart) {
            await runScanLatestOnStart();
          } else {
            await runScanSince();
          }
          started = true;
          attempt = 0;
          if (readyResolve) {
            readyResolve();
            readyResolve = null;
          }
        } else {
          await runScanSince();
          attempt = 0;
        }

        let slept = 0;
        while (slept < pollingSeconds && !stopped) {
          await delay(1000);
          slept += 1;
        }
      } catch (err) {
        log(account.label, `Watcher loop error: ${(err as Error)?.message ?? String(err)}`);
        if (readyResolve) {
          // first attempt failed; keep waiting for first success
        }
        if (!stopped) {
          log(account.label, `Reconnect backoff ${backoffMs}ms`);
          await delay(backoffMs);
        }
      }
    }
  };

  runPromise = run();

  return {
    ready,
    async stop() {
      stopped = true;
      await Promise.allSettled([runPromise ?? Promise.resolve()]);
    },
  };
}

export function buildImapAccountConfigFromEnvShape(account: {
  label: string;
  server: string;
  user: string;
  password: string;
  folder: string;
}): ImapAccountConfig {
  const server = account.server.trim();

  if (server.startsWith("imap://") || server.startsWith("imaps://")) {
    const url = new URL(server);
    return {
      label: account.label,
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "imaps:" ? 993 : 143,
      secure: url.protocol === "imaps:",
      user: account.user,
      password: account.password,
      folder: account.folder,
    };
  }

  const lastColon = server.lastIndexOf(":");
  const host = lastColon === -1 ? server : server.slice(0, lastColon);
  const port = lastColon === -1 ? 993 : Number(server.slice(lastColon + 1));

  if (!host) throw new Error(`Invalid server host in "${account.server}"`);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid server port in "${account.server}"`);

  return {
    label: account.label,
    host,
    port,
    secure: port === 993,
    user: account.user,
    password: account.password,
    folder: account.folder,
  };
}

export async function listMailboxFolders(client: ImapFlow): Promise<string[]> {
  const tree = await client.listTree();
  const paths: string[] = [];
  const visit = (node: ListTreeResponse) => {
    if (node.path) paths.push(node.path);
    for (const child of node.folders ?? []) visit(child);
  };
  visit(tree);
  return Array.from(new Set(paths)).sort((a, b) => a.localeCompare(b));
}
