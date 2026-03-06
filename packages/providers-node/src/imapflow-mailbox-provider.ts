import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AccountConfig, EmailMessage, MailboxProvider } from "../../body/src/index.js";

function accountKey(account: AccountConfig): string {
  return `${account.id}|${account.user}@${account.host}:${account.port}|${account.folder}`;
}

type Session = {
  client: ImapFlow;
  openedUidNext: number;
  delimiter: string;
};

export class ImapflowMailboxProvider implements MailboxProvider {
  private readonly sessions = new Map<string, Session>();

  async connect(account: AccountConfig): Promise<void> {
    const key = accountKey(account);
    if (this.sessions.has(key)) return;

    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: { user: account.user, pass: account.password },
      logger: false,
      socketTimeout: 15 * 60 * 1000,
      maxIdleTime: 4 * 60 * 1000,
    });

    client.on("error", () => {});
    await client.connect();
    const opened = await client.mailboxOpen(account.folder);

    this.sessions.set(key, {
      client,
      openedUidNext: opened.uidNext ?? 1,
      delimiter: opened.delimiter ?? ".",
    });
  }

  async disconnect(account: AccountConfig): Promise<void> {
    const key = accountKey(account);
    const session = this.sessions.get(key);
    if (!session) return;

    this.sessions.delete(key);
    await session.client.logout().catch(() => session.client.close());
  }

  private getSession(account: AccountConfig): Session {
    const key = accountKey(account);
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error("Mailbox session is not connected");
    }
    return session;
  }

  async getBaselineUid(account: AccountConfig): Promise<number> {
    const session = this.getSession(account);
    return Math.max(0, session.openedUidNext - 1);
  }

  async listLatestUids(account: AccountConfig, latestN: number): Promise<number[]> {
    const session = this.getSession(account);
    const baselineUid = await this.getBaselineUid(account);
    const startUid = Math.max(1, baselineUid - latestN + 1);

    const lock = await session.client.getMailboxLock(account.folder);
    try {
      const fetched = await session.client.fetchAll(`${startUid}:*`, { uid: true }, { uid: true });
      return fetched.map((m) => m.uid).filter((n): n is number => typeof n === "number");
    } finally {
      lock.release();
    }
  }

  async listUidsSince(account: AccountConfig, sinceUid: number): Promise<number[]> {
    const session = this.getSession(account);
    const fromUid = Math.max(1, sinceUid + 1);

    const lock = await session.client.getMailboxLock(account.folder);
    try {
      const fetched = await session.client.fetchAll(`${fromUid}:*`, { uid: true }, { uid: true });
      return fetched.map((m) => m.uid).filter((n): n is number => typeof n === "number");
    } finally {
      lock.release();
    }
  }

  async fetchMessage(account: AccountConfig, uid: number): Promise<EmailMessage | null> {
    const session = this.getSession(account);
    const lock = await session.client.getMailboxLock(account.folder);
    let source: Buffer | null = null;
    let envelopeSubject = "";
    let envelopeFrom = "";
    let envelopeTo = "";

    try {
      const msg = await session.client.fetchOne(
        String(uid),
        { uid: true, envelope: true, source: true },
        { uid: true },
      );
      if (!msg || !msg.source) return null;
      source = msg.source;
      envelopeSubject = msg.envelope?.subject ?? "";
      envelopeFrom = msg.envelope?.from?.[0]?.address ?? "";
      envelopeTo = (msg.envelope?.to ?? []).map((a) => a.address ?? "").filter(Boolean).join(", ");
    } finally {
      lock.release();
    }

    const parsed = await simpleParser(source);
    const parsedFromObj = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
    const parsedToObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;

    return {
      uid,
      from: parsedFromObj?.value?.[0]?.address ?? envelopeFrom ?? "",
      to:
        (parsedToObj?.value ?? [])
          .map((v: { address?: string | undefined }) => v.address ?? "")
          .filter(Boolean)
          .join(", ") || envelopeTo || "",
      subject: parsed.subject ?? envelopeSubject ?? "",
      bodyText: parsed.text ?? "",
    };
  }

  async flagMessages(account: AccountConfig, uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    const session = this.getSession(account);
    const unique = Array.from(new Set(uids)).sort((a, b) => a - b);

    const lock = await session.client.getMailboxLock(account.folder);
    try {
      await session.client.messageFlagsAdd(unique, ["\\Flagged"], { uid: true });
    } finally {
      lock.release();
    }
  }

  async moveMessagesToPhishing(account: AccountConfig, uids: number[]): Promise<void> {
    if (uids.length === 0) return;
    const session = this.getSession(account);
    const unique = Array.from(new Set(uids)).sort((a, b) => a - b);
    const phishingPath = `INBOX${session.delimiter}Phishing`;

    try {
      await session.client.mailboxCreate(phishingPath);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (!/exists|already/i.test(msg)) {
        throw err instanceof Error ? err : new Error(msg);
      }
    }

    const lock = await session.client.getMailboxLock(account.folder);
    try {
      await session.client.messageMove(unique, phishingPath, { uid: true });
    } finally {
      lock.release();
    }
  }
}
