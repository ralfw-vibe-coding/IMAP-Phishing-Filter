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
  uid: number;
  accountLabel: string;
  from: string;
  subject: string;
  result: PhishingCheckResult;
}) {
  logPhishing(
    args.accountLabel,
    `PHISHING UID ${args.uid} (p=${args.result.probability.toFixed(2)}): from="${args.from}" subject="${args.subject}"`,
  );
  logPhishing(args.accountLabel, `Explanation: ${args.result.explanation}`);
}

async function flagPhishingMessages(args: {
  client: ImapFlow;
  uids: number[];
  accountLabel: string;
  context: string;
}) {
  if (args.uids.length === 0) return;
  const unique = Array.from(new Set(args.uids)).sort((a, b) => a - b);
  try {
    logPhishing(
      args.accountLabel,
      `Flagging ${unique.length} message(s) as \\\\Flagged (context=${args.context})...`,
    );
    const ok = await args.client.messageFlagsAdd(unique, ["\\Flagged"], { uid: true });
    logPhishing(
      args.accountLabel,
      `Flagged ${unique.length} message(s) as \\\\Flagged (context=${args.context}) ok=${ok}`,
    );
    if (!ok) {
      logPhishing(
        args.accountLabel,
        `Batch flagging returned ok=false; retrying individually (context=${args.context})`,
      );
      for (const uid of unique) {
        try {
          const okOne = await args.client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
          logPhishing(args.accountLabel, `Flagged UID ${uid} individually ok=${okOne}`);
        } catch (err) {
          logPhishing(
            args.accountLabel,
            `Failed to flag UID ${uid} individually: ${(err as Error)?.message ?? String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    logPhishing(
      args.accountLabel,
      `Failed to flag messages (context=${args.context}): ${(err as Error)?.message ?? String(err)}`,
    );
  }
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
  let runPromise: Promise<void> | null = null;

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  let processingChain = Promise.resolve();
  let pendingCatchUp = false;

  const fetchMessageDataByUid = async (activeClient: ImapFlow, uid: number) => {
    const lock = await activeClient.getMailboxLock(account.folder);
    try {
      const msg = await activeClient.fetchOne(String(uid), { uid: true, envelope: true, source: true }, { uid: true });
      if (!msg || !msg.source) return null;

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

      const bodyText = parsed.text ?? "";

      return { uid, from: from ?? "", to, subject, bodyText };
    } finally {
      lock.release();
    }
  };

  const flagUids = async (activeClient: ImapFlow, uids: number[], context: string) => {
    if (uids.length === 0) return;
    const lock = await activeClient.getMailboxLock(account.folder);
    try {
      await flagPhishingMessages({ client: activeClient, uids, accountLabel: account.label, context });
    } finally {
      lock.release();
    }
  };

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
    const activeClient = client;
    if (!activeClient) return;
    if (lastSeenUid === null) {
      log(account.label, `Skip catch-up (no lastSeenUid) [reason=${reason}]`);
      return;
    }

    const fromUid = lastSeenUid + 1;
    log(account.label, `Catch-up start from UID ${fromUid} [reason=${reason}]`);

    // Step 1: collect new UIDs quickly (no slow AI calls while a FETCH is active)
    const uidLock = await activeClient.getMailboxLock(account.folder);
    let uids: number[] = [];
    try {
      const fetched = await activeClient.fetchAll(`${fromUid}:*`, { uid: true }, { uid: true });
      uids = fetched.map((m) => m.uid).filter((n): n is number => typeof n === "number");
    } finally {
      uidLock.release();
    }

    if (uids.length === 0) {
      log(account.label, `Catch-up: no new messages since UID ${fromUid - 1}`);
      return;
    }

    uids.sort((a, b) => a - b);
    lastSeenUid = Math.max(lastSeenUid, uids[uids.length - 1]!);
    log(account.label, `Catch-up: found ${uids.length} new UID(s), lastSeenUid=${lastSeenUid}`);

    // Step 2: fetch+parse per UID under short locks; run AI outside lock; flag at end
    const uidsToFlag: number[] = [];
    for (const uid of uids) {
      if (stopped) break;
      log(account.label, `Catch-up UID ${uid}: fetching+parsing`);
      const data = await fetchMessageDataByUid(activeClient, uid);
      if (!data) {
        log(account.label, `Catch-up UID ${uid}: missing source, skipping`);
        continue;
      }

      log(account.label, `Catch-up UID ${uid}: parsed from="${data.from}" subject="${data.subject}"`);
      const result = await checkForPhishingAttempt(data.from, data.to, data.subject, data.bodyText);
      const treat = shouldTreatAsPhishingAttempt(result);
      log(account.label, `Catch-up UID ${uid}: check result p=${result.probability.toFixed(2)} treat=${treat}`);

      if (treat) {
        uidsToFlag.push(uid);
        log(account.label, `Catch-up UID ${uid}: collected as phishing (pending flagging)`);
        await handlePhishingEmail({
          uid,
          accountLabel: account.label,
          from: data.from,
          subject: data.subject,
          result,
        });
      }
    }

    if (!stopped) {
      log(account.label, `Catch-up: collected ${uidsToFlag.length} phishing message(s) to flag`);
      await flagUids(activeClient, uidsToFlag, "catch-up");
    }

    log(account.label, `Catch-up done, processed=${uids.length}, flagged=${uidsToFlag.length}, lastSeenUid=${lastSeenUid}`);
  };

  const scanLatestOnStart = async (opened: { exists: number; uidNext?: number }) => {
    const activeClient = client;
    if (!activeClient) return;
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
    const range = `${startSeq}:${exists}`;

    log(account.label, `Start-scan: collecting up to ${max} newest UID(s) (seq ${range})`);

    const uidLock = await activeClient.getMailboxLock(account.folder);
    let uids: number[] = [];
    try {
      const fetched = await activeClient.fetchAll(range, { uid: true });
      uids = fetched.map((m) => m.uid).filter((n): n is number => typeof n === "number");
    } finally {
      uidLock.release();
    }

    uids = uids.slice(-max).sort((a, b) => a - b);
    log(account.label, `Start-scan: collected ${uids.length} UID(s)`);

    const uidsToFlag: number[] = [];
    for (const uid of uids) {
      if (stopped) break;
      log(account.label, `Start-scan UID ${uid}: fetching+parsing`);
      const data = await fetchMessageDataByUid(activeClient, uid);
      if (!data) {
        log(account.label, `Start-scan UID ${uid}: missing source, skipping`);
        continue;
      }

      log(account.label, `Start-scan UID ${uid}: parsed from="${data.from}" subject="${data.subject}"`);
      const result = await checkForPhishingAttempt(data.from, data.to, data.subject, data.bodyText);
      const treat = shouldTreatAsPhishingAttempt(result);
      log(account.label, `Start-scan UID ${uid}: check result p=${result.probability.toFixed(2)} treat=${treat}`);

      if (treat) {
        uidsToFlag.push(uid);
        log(account.label, `Start-scan UID ${uid}: collected as phishing (pending flagging)`);
        await handlePhishingEmail({
          uid,
          accountLabel: account.label,
          from: data.from,
          subject: data.subject,
          result,
        });
      }
    }

    if (!stopped) {
      log(account.label, `Start-scan: collected ${uidsToFlag.length} phishing message(s) to flag`);
      await flagUids(activeClient, uidsToFlag, "start-scan");
    }

    log(account.label, `Start-scan done, processed=${uids.length}, flagged=${uidsToFlag.length}`);
  };

  const run = async () => {
    let attempt = 0;

    while (!stopped) {
      attempt += 1;
      const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, attempt - 1));

      try {
        const onError = (err: unknown) => {
          log(account.label, `Client error: ${(err as Error)?.message ?? String(err)}`);
        };

        const onExists = (data: { path: string; count: number; prevCount: number }) => {
          if (data.path !== account.folder) return;
          log(account.label, `EXISTS: count ${data.prevCount} -> ${data.count}`);
          scheduleCatchUp("exists");
        };

        const nextClient = new ImapFlow({
          host: account.host,
          port: account.port,
          secure: account.secure,
          auth: { user: account.user, pass: account.password },
          logger: false,
          // Default socketTimeout is 5min. This app can be "busy" (AI calls) for longer while holding a mailbox lock.
          socketTimeout: 15 * 60 * 1000,
          // Refresh IDLE periodically to keep connections stable in long-running sessions.
          maxIdleTime: 4 * 60 * 1000,
        });
        client = nextClient;
        // Attach immediately so 'error' does not crash the process (EventEmitter default behavior).
        nextClient.on("error", onError);
        nextClient.on("exists", onExists);

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

        const closed = new Promise<void>((resolve) => {
          const done = () => resolve();
          nextClient.once("close", done);
          nextClient.once("end", done as any);
        });

        attempt = 0; // reset backoff after successful connect
        await closed;

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
