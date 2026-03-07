import { getScanStatus, setHealthAlertArmed } from "./runtime.js";

type HealthState = "up" | "down";

type HealthReport = {
  state: HealthState;
  reason: string;
  details: Awaited<ReturnType<typeof getScanStatus>>;
};

function evaluateHealth(status: Awaited<ReturnType<typeof getScanStatus>>): HealthReport {
  if (!status.status) {
    return { state: "down", reason: "No scan status available yet", details: status };
  }

  if (status.status.status === "error") {
    return {
      state: "down",
      reason: `Last scan reported error: ${status.status.message ?? "unknown"}`,
      details: status,
    };
  }

  const ageMs = Math.max(0, status.nowUnixMs - status.status.updatedAtUnixMs);
  const maxAgeMs = 10 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    return {
      state: "down",
      reason: `Last status is stale (${Math.floor(ageMs / 1000)}s old)`,
      details: status,
    };
  }

  return { state: "up", reason: "Service responded and status is fresh", details: status };
}

async function sendEmail(args: {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing RESEND_API_KEY");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: args.from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Resend API failed (${response.status}): ${text}`);
  }
}

function buildRearmUrl(baseUrl: string): string {
  const token = process.env.HEALTH_REARM_TOKEN?.trim();
  if (!token) {
    return `${baseUrl.replace(/\/+$/, "")}/.netlify/functions/health-rearm`;
  }
  return `${baseUrl.replace(/\/+$/, "")}/.netlify/functions/health-rearm?token=${encodeURIComponent(token)}`;
}

function buildEmail(args: {
  report: HealthReport;
  rearmUrl: string;
  baseUrl: string;
  checkedAtIso: string;
}): { subject: string; text: string; html: string } {
  const icon = args.report.state === "up" ? "UP" : "DOWN";
  const subject = `PhishingKiller Health ${icon} (${args.checkedAtIso})`;

  const text = [
    `Health check result: ${icon}`,
    `Checked at: ${args.checkedAtIso}`,
    `Reason: ${args.report.reason}`,
    "",
    `Service base URL: ${args.baseUrl}`,
    `Version: ${args.report.details.version}`,
    `Store: ${args.report.details.storeKind} (upstashConfigured=${String(args.report.details.upstashConfigured)})`,
    `Busy: ${String(args.report.details.busy)}`,
    "",
    "Account status:",
    ...args.report.details.accounts.map(
      (a) => `- ${a.accountId} (${a.label}): lastSeenUid=${a.lastSeenUid ?? "null"}`,
    ),
    "",
    "Future mode (one alert per outage):",
    "If notifications are paused, click this rearm link to enable alerts again:",
    args.rearmUrl,
  ].join("\n");

  const html = `
    <h2>PhishingKiller Health: ${icon}</h2>
    <p><strong>Checked at:</strong> ${args.checkedAtIso}</p>
    <p><strong>Reason:</strong> ${args.report.reason}</p>
    <p><strong>Service:</strong> ${args.baseUrl}</p>
    <p><strong>Version:</strong> ${args.report.details.version}</p>
    <p><strong>Store:</strong> ${args.report.details.storeKind} (upstashConfigured=${String(args.report.details.upstashConfigured)})</p>
    <p><strong>Busy:</strong> ${String(args.report.details.busy)}</p>
    <h3>Accounts</h3>
    <ul>
      ${args.report.details.accounts
        .map((a) => `<li>${a.accountId} (${a.label}): lastSeenUid=${a.lastSeenUid ?? "null"}</li>`)
        .join("")}
    </ul>
    <h3>Future mode (one alert per outage)</h3>
    <p>If notifications are paused, click this link to enable alerts again:</p>
    <p><a href="${args.rearmUrl}">${args.rearmUrl}</a></p>
  `.trim();

  return { subject, text, html };
}

export async function runHealthCheck() {
  const to = process.env.ALERT_EMAIL_TO?.trim();
  const from = process.env.ALERT_EMAIL_FROM?.trim();
  const baseUrl = (process.env.URL ?? process.env.DEPLOY_URL)?.trim();

  if (!to) throw new Error("Missing ALERT_EMAIL_TO");
  if (!from) throw new Error("Missing ALERT_EMAIL_FROM");
  if (!baseUrl) throw new Error("Missing URL/DEPLOY_URL");

  const status = await getScanStatus();
  const report = evaluateHealth(status);
  const checkedAtIso = new Date().toISOString();
  const rearmUrl = buildRearmUrl(baseUrl);
  const email = buildEmail({ report, rearmUrl, baseUrl, checkedAtIso });

  await sendEmail({
    to,
    from,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  return { checkedAtIso, report };
}

export async function rearmHealthAlert() {
  await setHealthAlertArmed(true);
}
