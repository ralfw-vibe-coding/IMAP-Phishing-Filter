import { ImapFlow, type ListTreeResponse } from "imapflow";
import { simpleParser } from "mailparser";
import {
  checkForPhishingAttempt,
  shouldTreatAsPhishingAttempt,
  type PhishingCheckResult,
} from "./phishingfilter.js";

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
  green: "\u001b[32m",
  reset: "\u001b[0m",
} as const;

function log(accountLabel: string, message: string, extra?: unknown) {
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`${ANSI.green}[${now()}] [${accountLabel}] ${message}${ANSI.reset}`, extra);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`${ANSI.green}[${now()}] [${accountLabel}] ${message}${ANSI.reset}`);
}

function logPhishing(accountLabel: string, message: string, extra?: unknown) {
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`${ANSI.red}[${now()}] [${accountLabel}] ${message}${ANSI.reset}`, extra);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`${ANSI.red}[${now()}] [${accountLabel}] ${message}${ANSI.reset}`);
}

function formatAddress(name?: string, address?: string) {
  if (address && name) return `${name} <${address}>`;
  return address ?? name ?? "";
}

function joinAddresses(
  addrs: Array<{ name?: string; address?: string }> | undefined,
): string {
  if (!addrs?.length) return "";
  return addrs.map((a) => formatAddress(a.name, a.address)).filter(Boolean).join(", ");
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

async function handlePhishingEmail(args: {
  accountLabel: string;
  from: string;
  subject: string;
  result: PhishingCheckResult;
}) {
  logPhishing(
    args.accountLabel,
    `PHISHING (p=${args.result.probability.toFixed(2)}): from="${args.from}" subject="${args.subject}"`,
  );
  logPhishing(args.accountLabel, `Explanation: ${args.result.explanation}`);
}

export function startImapWatcher(
  account: ImapAccountConfig,
  opts?: { scanOnStart?: boolean; scanOnStartMax?: number },
): StopHandle & { ready: Promise<void> } {
  let stopped = false;
  let client: ImapFlow | null = null;
  let lastSeenUid: number | null = null;
  const scanOnStart = opts?.scanOnStart ?? false;
  const scanOnStartMax = Math.max(0, Math.min(10, opts?.scanOnStartMax ?? 10));
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let runPromise: Promise<void> | null = null;

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  let processingChain = Promise.resolve();
  let pendingCatchUp = false;

  const scheduleCatchUp = (reason: string) => {
    if (stopped) return;
    if (pendingCatchUp) return;
    pendingCatchUp = true;

    processingChain = processingChain
      .then(async () => {
        pendingCatchUp = false;
        await catchUp(reason);
      })
      .catch((err) => {
        log(account.label, `Catch-up failed: ${(err as Error)?.message ?? String(err)}`);
      });
  };

  const catchUp = async (reason: string) => {
    if (!client) return;
    if (lastSeenUid === null) {
      log(account.label, `Skip catch-up (no lastSeenUid) [reason=${reason}]`);
      return;
    }

    const fromUid = lastSeenUid + 1;
    log(account.label, `Catch-up start from UID ${fromUid} [reason=${reason}]`);

    const lock = await client.getMailboxLock(account.folder);
    try {
      let processed = 0;
      for await (const msg of client.fetch(
        `${fromUid}:*`,
        { uid: true, envelope: true, source: true },
        { uid: true },
      )) {
        if (stopped) break;
        processed += 1;
        const uid = msg.uid;
        if (typeof uid === "number") {
          lastSeenUid = Math.max(lastSeenUid, uid);
        }

        if (!msg.source) {
          log(account.label, `UID ${uid}: missing source, skipping`);
          continue;
        }

        try {
          const parsed = await simpleParser(msg.source);

          const parsedFromObj = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
          const parsedFrom = parsedFromObj?.value?.[0];

          const from =
            parsedFrom?.address ??
            formatAddress(msg.envelope?.from?.[0]?.name, msg.envelope?.from?.[0]?.address);

          const parsedToObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
          const to =
            (parsedToObj?.value ?? [])
              .map((v) => v.address ?? "")
              .filter(Boolean)
              .join(", ") || joinAddresses(msg.envelope?.to);

          const subject = parsed.subject ?? msg.envelope?.subject ?? "";

          const body = parsed.text ?? "";
          if (!body) {
            log(account.label, `UID ${uid}: no text body found (html ignored)`);
          }

          log(account.label, `UID ${uid}: parsed from="${from}" subject="${subject}"`);

          const result = await checkForPhishingAttempt(from ?? "", to, subject, body);
          const treat = shouldTreatAsPhishingAttempt(result);

          log(
            account.label,
            `UID ${uid}: check result p=${result.probability.toFixed(2)} treat=${treat}`,
          );

          if (treat) {
            await handlePhishingEmail({
              accountLabel: account.label,
              from: from ?? "",
              subject,
              result,
            });
          }
        } catch (err) {
          log(account.label, `UID ${uid}: processing error: ${(err as Error)?.message ?? String(err)}`);
        }
      }

      log(account.label, `Catch-up done, processed=${processed}, lastSeenUid=${lastSeenUid}`);
    } finally {
      lock.release();
    }
  };

  const scanLatestOnStart = async (opened: { exists: number; uidNext?: number }) => {
    if (!client) return;
    if (!scanOnStart) return;

    const max = scanOnStartMax;
    if (max <= 0) {
      log(account.label, "Start-scan enabled but max=0, skipping");
      return;
    }

    const exists = opened.exists ?? 0;
    if (exists <= 0) {
      log(account.label, "Start-scan enabled but mailbox is empty");
      return;
    }

    const startSeq = Math.max(1, exists - max + 1);
    const range = `${startSeq}:*`;

    log(account.label, `Start-scan: fetching up to ${max} newest message(s) (seq ${range})`);

    const lock = await client.getMailboxLock(account.folder);
    try {
      let processed = 0;
      for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true })) {
        if (stopped) break;
        processed += 1;
        const uid = msg.uid;
        if (typeof uid === "number") {
          lastSeenUid = lastSeenUid === null ? uid : Math.max(lastSeenUid, uid);
        }

        if (!msg.source) {
          log(account.label, `Start-scan UID ${uid}: missing source, skipping`);
          if (processed >= max) break;
          continue;
        }

        try {
          const parsed = await simpleParser(msg.source);

          const parsedFromObj = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
          const parsedFrom = parsedFromObj?.value?.[0];

          const from =
            parsedFrom?.address ??
            formatAddress(msg.envelope?.from?.[0]?.name, msg.envelope?.from?.[0]?.address);

          const parsedToObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
          const to =
            (parsedToObj?.value ?? [])
              .map((v) => v.address ?? "")
              .filter(Boolean)
              .join(", ") || joinAddresses(msg.envelope?.to);

          const subject = parsed.subject ?? msg.envelope?.subject ?? "";

          const body = parsed.text ?? "";
          if (!body) {
            log(account.label, `Start-scan UID ${uid}: no text body found (html ignored)`);
          }

          log(account.label, `Start-scan UID ${uid}: parsed from="${from}" subject="${subject}"`);

          const result = await checkForPhishingAttempt(from ?? "", to, subject, body);
          const treat = shouldTreatAsPhishingAttempt(result);

          log(
            account.label,
            `Start-scan UID ${uid}: check result p=${result.probability.toFixed(2)} treat=${treat}`,
          );

          if (treat) {
            await handlePhishingEmail({
              accountLabel: account.label,
              from: from ?? "",
              subject,
              result,
            });
          }
        } catch (err) {
          log(
            account.label,
            `Start-scan UID ${uid}: processing error: ${(err as Error)?.message ?? String(err)}`,
          );
        }

        if (processed >= max) break;
      }

      log(account.label, `Start-scan done, processed=${processed}`);
    } finally {
      lock.release();
    }
  };

  const run = async () => {
    let attempt = 0;

    while (!stopped) {
      attempt += 1;
      const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, attempt - 1));

      try {
        const nextClient = new ImapFlow({
          host: account.host,
          port: account.port,
          secure: account.secure,
          auth: { user: account.user, pass: account.password },
          logger: false,
        });
        client = nextClient;

        log(account.label, `Connecting to ${account.host}:${account.port} (attempt ${attempt})`);
        await nextClient.connect();
        log(account.label, "Connected");

        try {
          const folders = await listMailboxFolders(nextClient);
          log(account.label, `Folders (${folders.length}):`);
          for (const folder of folders) {
            log(account.label, ` - ${folder}`);
          }
        } catch (err) {
          log(account.label, `Failed to list folders: ${(err as Error)?.message ?? String(err)}`);
        }

        const opened = await nextClient.mailboxOpen(account.folder);
        if (!opened) {
          throw new Error(`Failed to open mailbox "${account.folder}"`);
        }
        log(
          account.label,
          `Mailbox opened path="${account.folder}" exists=${opened.exists} uidNext=${opened.uidNext}`,
        );

        const uidNext = opened.uidNext ?? 1;
        const baselineUid = Math.max(0, uidNext - 1);

        if (lastSeenUid === null) {
          if (scanOnStart) {
            log(account.label, "Start-scan is enabled");
            await scanLatestOnStart(opened);
            lastSeenUid = Math.max(lastSeenUid ?? 0, baselineUid);
            log(account.label, `Baseline lastSeenUid=${lastSeenUid} (after start-scan)`);
          } else {
            lastSeenUid = baselineUid;
            log(account.label, `Baseline lastSeenUid=${lastSeenUid} (no initial scan)`);
          }
        } else {
          log(account.label, `Reconnect detected; lastSeenUid=${lastSeenUid}, baselineUid=${baselineUid}`);
          scheduleCatchUp("reconnect");
        }

        if (readyResolve) {
          readyResolve();
          readyResolve = null;
        }

        keepAliveTimer = setInterval(() => {
          if (!client || stopped) return;
          client
            .noop()
            .then(() => log(account.label, "NOOP keepalive ok"))
            .catch((err) =>
              log(account.label, `NOOP keepalive failed: ${(err as Error)?.message ?? String(err)}`),
            );
        }, 10 * 60 * 1000);

        const onExists = (data: { path: string; count: number; prevCount: number }) => {
          if (data.path !== account.folder) return;
          log(account.label, `EXISTS: count ${data.prevCount} -> ${data.count}`);
          scheduleCatchUp("exists");
        };

        const onError = (err: unknown) => {
          log(account.label, `Client error: ${(err as Error)?.message ?? String(err)}`);
        };

        nextClient.on("exists", onExists);
        nextClient.on("error", onError);

        const closed = new Promise<void>((resolve) => {
          const done = () => resolve();
          nextClient.once("close", done);
          nextClient.once("end", done as any);
        });

        attempt = 0; // reset backoff after successful connect
        await closed;

        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        nextClient.off("exists", onExists);
        nextClient.off("error", onError);

        log(account.label, "Disconnected; will reconnect");
      } catch (err) {
        log(account.label, `Watcher loop error: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        if (client) {
          // Avoid deadlocks: don't try to run LOGOUT while a FETCH generator might still be active.
          try {
            client.close();
          } catch {
            // ignore
          }
          client = null;
        }
      }

      if (!stopped) {
        log(account.label, `Reconnect backoff ${backoffMs}ms`);
        await delay(backoffMs);
      }
    }
  };

  runPromise = run();

  return {
    ready,
    async stop() {
      stopped = true;
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      // Force-close the socket to immediately break out of IDLE/FETCH.
      if (client) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      await Promise.allSettled([
        runPromise ?? Promise.resolve(),
        processingChain.catch(() => undefined),
      ]);
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
