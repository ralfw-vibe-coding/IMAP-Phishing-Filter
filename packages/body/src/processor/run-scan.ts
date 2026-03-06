import { shouldTreatAsPhishing } from "../domain/phishing.js";
import type { MailboxProvider, PhishingAiProvider, ScanObserver, StateProvider } from "../contracts/providers.js";
import type { ScanLogger, ScanRequest, ScanResult } from "../contracts/types.js";

type RunScanDeps = {
  mailbox: MailboxProvider;
  ai: PhishingAiProvider;
  state: StateProvider;
  logger?: ScanLogger;
  observer?: ScanObserver;
};

function dedupeSortAsc(uids: number[]): number[] {
  return Array.from(new Set(uids.filter((uid) => Number.isFinite(uid) && uid > 0))).sort((a, b) => a - b);
}

function quote(value: string) {
  return `"${value.replace(/\s+/g, " ").trim()}"`;
}

export async function runScan(request: ScanRequest, deps: RunScanDeps): Promise<ScanResult> {
  const { account } = request;
  const logger = deps.logger;

  await deps.mailbox.connect(account);
  try {
    const baselineUid = await deps.mailbox.getBaselineUid(account);
    logger?.info(`CHECK START folder=${quote(account.folder)}`);

    let uids: number[] = [];
    if (request.kind === "since") {
      const sinceUidFromState = await deps.state.getLastSeenUid(account.id);
      const sinceUid = request.sinceUid ?? sinceUidFromState ?? baselineUid;
      uids = await deps.mailbox.listUidsSince(account, sinceUid);
      uids = dedupeSortAsc(uids).filter((uid) => uid > sinceUid);
      if (request.maxMessages && request.maxMessages > 0) {
        uids = uids.slice(0, request.maxMessages);
      }
    } else {
      const latestN = Math.max(1, request.latestN ?? 10);
      uids = dedupeSortAsc(await deps.mailbox.listLatestUids(account, latestN));
      if (uids.length > latestN) {
        uids = uids.slice(-latestN);
      }
    }

    if (uids.length === 0) {
      const emptyResult = { lastSeenUid: baselineUid, processed: 0, flagged: 0 };
      await deps.state.setLastSeenUid(account.id, emptyResult.lastSeenUid);
      await deps.observer?.onResult?.(emptyResult);
      logger?.info("CHECK END checked=0");
      return emptyResult;
    }

    const phishingUids: number[] = [];
    let maxProcessedUid = baselineUid;

    for (const uid of uids) {
      const message = await deps.mailbox.fetchMessage(account, uid);
      if (!message) continue;

      logger?.info(
        `  from=${quote(message.from)} to=${quote(message.to)} subject=${quote(message.subject)}`,
      );

      const assessment = await deps.ai.assess(message);
      const threshold = account.phishingThreshold ?? 0.5;
      const treat = shouldTreatAsPhishing(assessment, threshold);
      if (treat) {
        phishingUids.push(uid);
        logger?.warn(`    PHISHING: ${assessment.explanation}`);
      }

      maxProcessedUid = Math.max(maxProcessedUid, uid);
      await deps.state.setLastSeenUid(account.id, maxProcessedUid);
      await deps.observer?.onProgress?.({ lastSeenUid: maxProcessedUid });
    }

    if (phishingUids.length > 0) {
      if (account.phishingTreatment === "move_to_phishing_folder") {
        await deps.mailbox.moveMessagesToPhishing(account, phishingUids);
      } else {
        await deps.mailbox.flagMessages(account, phishingUids);
      }
    }

    const result: ScanResult = {
      lastSeenUid: maxProcessedUid,
      processed: uids.length,
      flagged: phishingUids.length,
    };
    await deps.state.setLastSeenUid(account.id, result.lastSeenUid);
    await deps.observer?.onResult?.(result);
    logger?.info(`CHECK END checked=${result.processed}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error(`CHECK ERROR: ${message}`);
    throw error;
  } finally {
    await deps.mailbox.disconnect(account);
  }
}
