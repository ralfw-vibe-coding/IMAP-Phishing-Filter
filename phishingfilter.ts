export type PhishingCheckResult = {
  probability: number; // 0..1
  explanation: string;
};

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runPhishingAssessmentPrompt } from "./ai.js";

const PROMPT_PATH = resolve(process.cwd(), "phishingdetection_prompt.txt");
let cachedPromptTemplate: string | null = null;

async function loadPromptTemplate(): Promise<string> {
  if (cachedPromptTemplate !== null) return cachedPromptTemplate;
  cachedPromptTemplate = await readFile(PROMPT_PATH, "utf8");
  return cachedPromptTemplate;
}

function buildEmailBlock(args: { from: string; to: string; subject: string; body: string }) {
  return [
    `from: ${args.from}`,
    `to: ${args.to}`,
    `subject: ${args.subject}`,
    `body: ${args.body}`,
  ].join("\n");
}

export async function checkForPhishingAttempt(
  from: string,
  to: string,
  subject: string,
  body: string,
): Promise<PhishingCheckResult> {
  const template = await loadPromptTemplate();
  const email = buildEmailBlock({ from, to, subject, body });

  const prompt = template.includes("$email") ? template.replace("$email", email) : `${template}\n\n${email}`;
  return runPhishingAssessmentPrompt(prompt);
}

export function shouldTreatAsPhishingAttempt(result: PhishingCheckResult): boolean {
  return result.probability > 0.5;
}
