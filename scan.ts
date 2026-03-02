import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { checkForPhishingAttempt, shouldTreatAsPhishingAttempt } from "./phishingfilter.js";
import { buildImapAccountConfigFromEnvShape } from "./imap.js";

type EnvAccountShape = {
  label: string;
  server: string;
  user: string;
  password: string;
  folder: string;
};

const now = () => new Date().toISOString();

function log(label: string, message: string) {
  // eslint-disable-next-line no-console
  console.log(`[${now()}] [${label}] ${message}`);
}

function scanResultLine(payload: unknown) {
  // This line is parsed by the desktop app. Keep it single-line.
  // eslint-disable-next-line no-console
  console.log(`@@SCAN_RESULT@@ ${JSON.stringify(payload)}`);
}

function scanProgressLine(payload: unknown) {
  // This line is parsed by the desktop app to persist progress even if the scan crashes.
  // eslint-disable-next-line no-console
  console.log(`@@SCAN_PROGRESS@@ ${JSON.stringify(payload)}`);
}

async function main() {
  const raw = process.env.SCAN_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing SCAN_ACCOUNT_JSON env var");

  const scanKind = (process.env.SCAN_KIND ?? "latest").toLowerCase();
  const latestN = Math.max(
    1,
    Math.min(1000, Number.parseInt(process.env.SCAN_LATEST_N ?? "10", 10) || 10),
  );
  const sinceUidRaw = process.env.SCAN_SINCE_UID?.trim();
  const sinceUid = sinceUidRaw ? Number.parseInt(sinceUidRaw, 10) : null;
  const maxMessagesRaw = process.env.SCAN_MAX_MESSAGES?.trim();
  const maxMessages = maxMessagesRaw ? Math.max(1, Number.parseInt(maxMessagesRaw, 10) || 1) : null;
  const phishingAction = (process.env.SCAN_PHISHING_ACTION ?? "flag").toLowerCase(); // "flag" | "move"

  const account = JSON.parse(raw) as EnvAccountShape;
  const config = buildImapAccountConfigFromEnvShape(account);

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    logger: false,
    socketTimeout: 15 * 60 * 1000,
    maxIdleTime: 4 * 60 * 1000,
  });

  client.on("error", (err) => log(config.label, `Client error: ${(err as Error)?.message ?? String(err)}`));

  log(config.label, `Connecting to ${config.host}:${config.port}`);
  await client.connect();
  log(config.label, "Connected");

  const opened = await client.mailboxOpen(config.folder);
  log(config.label, `Mailbox opened path="${config.folder}" exists=${opened.exists} uidNext=${opened.uidNext}`);

  const baselineUid = Math.max(0, (opened.uidNext ?? 1) - 1);

  const ensurePhishingMailbox = async () => {
    const delimiter = opened.delimiter ?? ".";
    const phishingPath = `INBOX${delimiter}Phishing`;
    try {
      await client.mailboxCreate(phishingPath);
      log(config.label, `Created mailbox folder "${phishingPath}"`);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // If it already exists, ignore. Otherwise still proceed (MOVE will fail with a clearer error).
      if (/exists|already/i.test(msg)) {
        return;
      }
      log(config.label, `Warning: failed to create mailbox "${phishingPath}": ${msg}`);
    }
  };

  const treatPhishing = async (uids: number[], context: string) => {
    if (uids.length === 0) return;

    if (phishingAction === "move") {
      const delimiter = opened.delimiter ?? ".";
      const phishingPath = `INBOX${delimiter}Phishing`;
      log(config.label, `Collected ${uids.length} phishing message(s) to move (context=${context})`);
      await ensurePhishingMailbox();
      const lock = await client.getMailboxLock(config.folder);
      try {
        const res = await client.messageMove(uids, phishingPath, { uid: true });
        const moved = typeof res === "object" && res && "uidMap" in (res as any) ? (res as any).uidMap?.size : null;
        log(config.label, `Moved ${uids.length} message(s) to "${phishingPath}"${moved !== null ? ` (uidMap=${moved})` : ""}`);
      } finally {
        lock.release();
      }
      return;
    }

    log(config.label, `Collected ${uids.length} phishing message(s) to flag (context=${context})`);
    const lock = await client.getMailboxLock(config.folder);
    try {
      const ok = await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
      log(config.label, `Flagged ${uids.length} message(s) ok=${ok}`);
    } finally {
      lock.release();
    }
  };

  if (scanKind === "since") {
    if (sinceUid === null || !Number.isFinite(sinceUid)) {
      log(config.label, `Auto scan: baseline only (no lastSeenUid yet). Setting lastSeenUid=${baselineUid}`);
      scanResultLine({ lastSeenUid: baselineUid, processed: 0, flagged: 0 });
      await client.logout().catch(() => client.close());
      log(config.label, "Done");
      return;
    }

    const fromUid = sinceUid + 1;
    log(config.label, `Auto scan: collecting messages since UID ${sinceUid} (from UID ${fromUid})`);

    const uidLock = await client.getMailboxLock(config.folder);
    let uids: number[] = [];
    try {
      const fetched = await client.fetchAll(`${fromUid}:*`, { uid: true }, { uid: true });
      uids = fetched.map((m) => m.uid).filter((n): n is number => typeof n === "number");
    } finally {
      uidLock.release();
    }

    const preFilterCount = uids.length;
    uids = uids.filter((uid) => uid > sinceUid);
    if (preFilterCount !== uids.length) {
      log(
        config.label,
        `Auto scan: ignored ${preFilterCount - uids.length} UID(s) <= lastSeenUid=${sinceUid} (server returned unexpected UIDs)`,
      );
    }

    uids.sort((a, b) => a - b);
    if (maxMessages && uids.length > maxMessages) {
      uids = uids.slice(0, maxMessages);
      log(config.label, `Auto scan: limiting to first ${maxMessages} message(s) this run`);
    }

    if (uids.length === 0) {
      log(config.label, "Auto scan: no new messages");
      scanResultLine({ lastSeenUid: Math.max(baselineUid, sinceUid), processed: 0, flagged: 0 });
      await client.logout().catch(() => client.close());
      log(config.label, "Done");
      return;
    }

    log(config.label, `Auto scan: collected ${uids.length} new UID(s)`);

    const phishingUids: number[] = [];
    let processed = 0;
    let maxProcessedUid = sinceUid;

    for (const uid of uids) {
      processed += 1;
      maxProcessedUid = Math.max(maxProcessedUid, uid);

      log(config.label, `UID ${uid}: fetching source`);

      const lock = await client.getMailboxLock(config.folder);
      let source: Buffer | null = null;
      let envelopeSubject = "";
      let envelopeFrom = "";
      let envelopeTo = "";
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, source: true }, { uid: true });
        if (!msg || !msg.source) {
          log(config.label, `UID ${uid}: missing source, skipping`);
          continue;
        }
        source = msg.source;
        envelopeSubject = msg.envelope?.subject ?? "";
        envelopeFrom = msg.envelope?.from?.[0]?.address ?? "";
        envelopeTo = (msg.envelope?.to ?? []).map((a) => a.address ?? "").filter(Boolean).join(", ");
      } finally {
        lock.release();
      }

      const parsed = await simpleParser(source);
      const subject = parsed.subject ?? envelopeSubject ?? "";
      const parsedFromObj = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
      const from = parsedFromObj?.value?.[0]?.address ?? envelopeFrom ?? "";
      const parsedToObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
      const to =
        (parsedToObj?.value ?? [])
          .map((v: { address?: string | undefined }) => v.address ?? "")
          .filter(Boolean)
          .join(", ") || envelopeTo || "";
      const bodyText = parsed.text ?? "";

      log(config.label, `UID ${uid}: parsed from="${from}" subject="${subject}"`);

      const result = await checkForPhishingAttempt(from, to, subject, bodyText);
      const treat = shouldTreatAsPhishingAttempt(result);
      log(config.label, `UID ${uid}: check result p=${result.probability.toFixed(2)} treat=${treat}`);

      if (treat) {
        phishingUids.push(uid);
        log(config.label, `UID ${uid}: PHISHING (pending flagging)`);
        log(config.label, `UID ${uid}: Explanation: ${result.explanation}`);
      }

      // Persist progress after every checked message so we don't re-check it after a crash.
      scanProgressLine({ lastSeenUid: uid });
    }

    if (phishingUids.length > 0) {
      await treatPhishing(phishingUids, "auto");
    } else {
      log(config.label, "No phishing detected in new messages");
    }

    const lastSeenUid = Math.max(baselineUid, maxProcessedUid);
    scanResultLine({ lastSeenUid, processed, flagged: phishingUids.length });

    await client.logout().catch(() => client.close());
    log(config.label, "Done");
    return;
  }

  // Default: latest-N scan (on-demand)
  const startUid = Math.max(1, baselineUid - latestN + 1);
  const range = `${startUid}:*`;
  log(config.label, `On-demand scan: collecting newest ~${latestN} message(s) (uid ${range}, uidNext=${opened.uidNext})`);

  const uidLock = await client.getMailboxLock(config.folder);
  let uids: number[] = [];
  try {
    const fetched = await client.fetchAll(range, { uid: true }, { uid: true });
    uids = fetched.map((m) => m.uid).filter((n): n is number => typeof n === "number");
  } finally {
    uidLock.release();
  }

  uids.sort((a, b) => a - b);
  if (uids.length > latestN) {
    uids = uids.slice(-latestN);
  }
  log(config.label, `On-demand scan: collected ${uids.length} UID(s)`);

  if (uids.length === 0) {
    log(config.label, "On-demand scan: no messages found; nothing to scan");
    scanResultLine({ lastSeenUid: baselineUid, processed: 0, flagged: 0 });
    await client.logout().catch(() => client.close());
    log(config.label, "Done");
    return;
  }

  const phishingUids: number[] = [];

  for (const uid of uids) {
    log(config.label, `UID ${uid}: fetching source`);

    const lock = await client.getMailboxLock(config.folder);
    let source: Buffer | null = null;
    let envelopeSubject = "";
    let envelopeFrom = "";
    let envelopeTo = "";
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, source: true }, { uid: true });
      if (!msg || !msg.source) {
        log(config.label, `UID ${uid}: missing source, skipping`);
        continue;
      }
      source = msg.source;
      envelopeSubject = msg.envelope?.subject ?? "";
      envelopeFrom = msg.envelope?.from?.[0]?.address ?? "";
      envelopeTo = (msg.envelope?.to ?? []).map((a) => a.address ?? "").filter(Boolean).join(", ");
    } finally {
      lock.release();
    }

    const parsed = await simpleParser(source);
    const subject = parsed.subject ?? envelopeSubject ?? "";
    const parsedFromObj = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
    const from = parsedFromObj?.value?.[0]?.address ?? envelopeFrom ?? "";
    const parsedToObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    const to =
      (parsedToObj?.value ?? [])
        .map((v: { address?: string | undefined }) => v.address ?? "")
        .filter(Boolean)
        .join(", ") || envelopeTo || "";
    const bodyText = parsed.text ?? "";

    log(config.label, `UID ${uid}: parsed from="${from}" subject="${subject}"`);

    const result = await checkForPhishingAttempt(from, to, subject, bodyText);
    const treat = shouldTreatAsPhishingAttempt(result);
    log(config.label, `UID ${uid}: check result p=${result.probability.toFixed(2)} treat=${treat}`);

    if (treat) {
      phishingUids.push(uid);
      log(config.label, `UID ${uid}: PHISHING (pending flagging)`);
      log(config.label, `UID ${uid}: Explanation: ${result.explanation}`);
    }

    // Persist progress after every checked message so we don't re-check it after a crash.
    scanProgressLine({ lastSeenUid: uid });
  }

  if (phishingUids.length > 0) {
    await treatPhishing(phishingUids, "on-demand");
  } else {
    log(config.label, "No phishing detected in selected messages");
  }

  const lastSeenUid = Math.max(baselineUid, uids.length > 0 ? uids[uids.length - 1]! : baselineUid);
  scanResultLine({ lastSeenUid, processed: uids.length, flagged: phishingUids.length });

  await client.logout().catch(() => client.close());
  log(config.label, "Done");
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[${now()}] [scan] fatal`, err);
  process.exit(1);
});
