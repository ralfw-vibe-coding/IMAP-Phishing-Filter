import type {
  AccountConfig,
  EmailMessage,
  PhishingAssessment,
  ScanProgress,
  ScanResult,
} from "./types.js";

export type MailboxProvider = {
  connect(account: AccountConfig): Promise<void>;
  disconnect(account: AccountConfig): Promise<void>;
  getBaselineUid(account: AccountConfig): Promise<number>;
  listLatestUids(account: AccountConfig, latestN: number): Promise<number[]>;
  listUidsSince(account: AccountConfig, sinceUid: number): Promise<number[]>;
  fetchMessage(account: AccountConfig, uid: number): Promise<EmailMessage | null>;
  flagMessages(account: AccountConfig, uids: number[]): Promise<void>;
  moveMessagesToPhishing(account: AccountConfig, uids: number[]): Promise<void>;
};

export type PhishingAiProvider = {
  assess(message: EmailMessage): Promise<PhishingAssessment>;
};

export type StateProvider = {
  getLastSeenUid(accountId: string): Promise<number | null>;
  setLastSeenUid(accountId: string, uid: number): Promise<void>;
};

export type ScanObserver = {
  onProgress?(progress: ScanProgress): Promise<void> | void;
  onResult?(result: ScanResult): Promise<void> | void;
};
