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

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message);
}

function quote(value: string) {
  return `"${value.replace(/\s+/g, " ").trim()}"`;
}

function logScanStart(folder: string) {
  log(`CHECK START folder=${quote(folder)}`);
}

function logCheckedMail(from: string, to: string, subject: string) {
  log(`  from=${quote(from)} to=${quote(to)} subject=${quote(subject)}`);
}

function logPhishingReason(explanation: string) {
  log(`    PHISHING: ${explanation}`);
}

function logScanEnd(checked: number) {
  log(`CHECK END checked=${checked}`);
}

function logScanError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log(`CHECK ERROR: ${message}`);
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

  client.on("error", () => {});
  await client.connect();
  const opened = await client.mailboxOpen(config.folder);
  const baselineUid = Math.max(0, (opened.uidNext ?? 1) - 1);
  logScanStart(config.folder);

  const ensurePhishingMailbox = async () => {
    const delimiter = opened.delimiter ?? ".";
    const phishingPath = `INBOX${delimiter}Phishing`;
    try {
      await client.mailboxCreate(phishingPath);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (/exists|already/i.test(msg)) {
        return phishingPath;
      }
      throw err instanceof Error ? err : new Error(msg);
    }
    return phishingPath;
  };

  const treatPhishing = async (uids: number[]) => {
    if (uids.length === 0) return;

    if (phishingAction === "move") {
      const phishingPath = await ensurePhishingMailbox();
      const lock = await client.getMailboxLock(config.folder);
      try {
        await client.messageMove(uids, phishingPath, { uid: true });
      } finally {
        lock.release();
      }
      return;
    }

    const lock = await client.getMailboxLock(config.folder);
    try {
      await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
    } finally {
      lock.release();
    }
  };

  try {
    if (scanKind === "since") {
      if (sinceUid === null || !Number.isFinite(sinceUid)) {
        logScanEnd(0);
        scanResultLine({ lastSeenUid: baselineUid, processed: 0, flagged: 0 });
        return;
      }

      const fromUid = sinceUid + 1;
      const uidLock = await client.getMailboxLock(config.folder);
      let uids: number[] = [];
      try {
        const fetched = await client.fetchAll(`${fromUid}:*`, { uid: true }, { uid: true });
        uids = fetched.map((m) => m.uid).filter((n): n is number => typeof n === "number");
      } finally {
        uidLock.release();
      }

      uids = uids.filter((uid) => uid > sinceUid);
      uids.sort((a, b) => a - b);
      if (maxMessages && uids.length > maxMessages) {
        uids = uids.slice(0, maxMessages);
      }

      if (uids.length === 0) {
        logScanEnd(0);
        scanResultLine({ lastSeenUid: Math.max(baselineUid, sinceUid), processed: 0, flagged: 0 });
        return;
      }

      const phishingUids: number[] = [];
      let processed = 0;
      let maxProcessedUid = sinceUid;

      for (const uid of uids) {
        processed += 1;
        maxProcessedUid = Math.max(maxProcessedUid, uid);

        const lock = await client.getMailboxLock(config.folder);
        let source: Buffer | null = null;
        let envelopeSubject = "";
        let envelopeFrom = "";
        let envelopeTo = "";
        try {
          const msg = await client.fetchOne(
            String(uid),
            { uid: true, envelope: true, source: true },
            { uid: true },
          );
          if (!msg || !msg.source) {
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

        logCheckedMail(from, to, subject);
        const result = await checkForPhishingAttempt(from, to, subject, bodyText);
        const treat = shouldTreatAsPhishingAttempt(result);

        if (treat) {
          phishingUids.push(uid);
          logPhishingReason(result.explanation);
        }

        scanProgressLine({ lastSeenUid: uid });
      }

      if (phishingUids.length > 0) await treatPhishing(phishingUids);

      const lastSeenUid = Math.max(baselineUid, maxProcessedUid);
      logScanEnd(processed);
      scanResultLine({ lastSeenUid, processed, flagged: phishingUids.length });
      return;
    }

    const startUid = Math.max(1, baselineUid - latestN + 1);
    const range = `${startUid}:*`;
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

    if (uids.length === 0) {
      logScanEnd(0);
      scanResultLine({ lastSeenUid: baselineUid, processed: 0, flagged: 0 });
      return;
    }

    const phishingUids: number[] = [];

    for (const uid of uids) {
      const lock = await client.getMailboxLock(config.folder);
      let source: Buffer | null = null;
      let envelopeSubject = "";
      let envelopeFrom = "";
      let envelopeTo = "";
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, source: true },
          { uid: true },
        );
        if (!msg || !msg.source) {
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

      logCheckedMail(from, to, subject);
      const result = await checkForPhishingAttempt(from, to, subject, bodyText);
      const treat = shouldTreatAsPhishingAttempt(result);

      if (treat) {
        phishingUids.push(uid);
        logPhishingReason(result.explanation);
      }

      scanProgressLine({ lastSeenUid: uid });
    }

    if (phishingUids.length > 0) await treatPhishing(phishingUids);

    const lastSeenUid = Math.max(baselineUid, uids.length > 0 ? uids[uids.length - 1]! : baselineUid);
    logScanEnd(uids.length);
    scanResultLine({ lastSeenUid, processed: uids.length, flagged: phishingUids.length });
  } catch (error) {
    logScanError(error);
    throw error;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

void main().catch(() => {
  process.exit(1);
});
