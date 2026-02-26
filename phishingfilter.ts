export type PhishingCheckResult = {
  probability: number; // 0..1
  explanation: string;
};

export function checkForPhishingAttempt(
  from: string,
  to: string,
  subject: string,
  body: string,
): PhishingCheckResult {
  const reasons: string[] = [];
  let score = 0;

  const subjectLower = subject.toLowerCase();
  const bodyLower = body.toLowerCase();

  const urgentSignals = ["dringend", "sofort", "urgent", "immediately", "account", "konto", "passwort", "password"];
  const threatSignals = ["gesperrt", "suspended", "blocked", "deaktiviert", "disabled", "unauthorized", "unbefugt"];
  const actionSignals = ["anmelden", "login", "verify", "bestätigen", "validate", "update", "aktualisieren"];

  const urlMatches = bodyLower.match(/\bhttps?:\/\/[^\s)>"']+/g) ?? [];

  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  if (urgentSignals.some((s) => subjectLower.includes(s) || bodyLower.includes(s))) {
    add(0.2, "Urgency/Account language detected");
  }
  if (threatSignals.some((s) => subjectLower.includes(s) || bodyLower.includes(s))) {
    add(0.2, "Threat/lockout language detected");
  }
  if (actionSignals.some((s) => subjectLower.includes(s) || bodyLower.includes(s))) {
    add(0.15, "Call-to-action language detected");
  }
  if (urlMatches.length > 0) {
    add(Math.min(0.25, 0.1 + urlMatches.length * 0.03), `Contains ${urlMatches.length} link(s)`);
  }
  if (from.includes("<") || from.includes(">")) {
    add(0.05, "From field looks like a display-name + address format");
  }
  if (to.length === 0) {
    add(0.05, "Missing To information");
  }

  const probability = Math.max(0, Math.min(1, score));
  const explanation =
    reasons.length > 0 ? reasons.join("; ") : "No strong phishing indicators found (baseline heuristic).";

  return { probability, explanation };
}

export function shouldTreatAsPhishingAttempt(result: PhishingCheckResult): boolean {
  return result.probability > 0.5;
}

