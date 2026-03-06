export type PhishingTreatment = "flag" | "move_to_phishing_folder";

export type ScanKind = "latest" | "since";

export type ScanLogger = {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
};

export type AccountConfig = {
  id: string;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  folder: string;
  phishingTreatment: PhishingTreatment;
  phishingThreshold?: number;
};

export type EmailMessage = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
};

export type PhishingAssessment = {
  probability: number;
  explanation: string;
};

export type ScanRequest = {
  account: AccountConfig;
  kind: ScanKind;
  latestN?: number;
  sinceUid?: number | null;
  maxMessages?: number | null;
};

export type ScanProgress = {
  lastSeenUid: number;
};

export type ScanResult = {
  lastSeenUid: number;
  processed: number;
  flagged: number;
};
