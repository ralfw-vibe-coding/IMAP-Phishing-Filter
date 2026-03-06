import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EmailMessage, PhishingAiProvider, PhishingAssessment } from "../../body/src/index.js";

const DEFAULT_PROMPT_TEMPLATE = `You are a phishing detection system.

Analyze the email below and decide how likely it is a phishing attempt.

Return ONLY valid JSON in this exact format:
{"probability": 0.0, "explanation": "..."}

Rules:
- probability must be a number between 0 and 1 (inclusive)
- explanation must be a short, concrete reason for the score

Here are criteria which increase the likelihood of the email being a phishing attempt:

1. The email instills a sense or urgency.
2. The email's origin according to the text (body) does not match the sender (from).
3. The email contains a link the user should click which does not match the sender (from).
4. The email contains a link the user should click which does not match the origin (body).
5. The email contains pretty much just an image and a link to click.

Email:
$email
`;

function extractJsonObject(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return text.trim();
  return text.slice(first, last + 1).trim();
}

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

function buildEmailBlock(args: { from: string; to: string; subject: string; body: string }) {
  return [
    `from: ${args.from}`,
    `to: ${args.to}`,
    `subject: ${args.subject}`,
    `body: ${args.body}`,
  ].join("\n");
}

export class OpenAiPhishingProvider implements PhishingAiProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly promptPath: string;
  private readonly promptTemplateOverride: string | undefined;
  private promptTemplate: string | null;

  constructor(args?: {
    apiKey?: string;
    model?: string;
    promptPath?: string;
    promptTemplate?: string;
  }) {
    const apiKey = args?.apiKey ?? process.env.AI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing AI_API_KEY in environment");
    }
    this.client = new OpenAI({ apiKey });
    this.model = args?.model ?? "gpt-5-mini";
    this.promptPath = args?.promptPath ?? resolve(process.cwd(), "phishingdetection_prompt.txt");
    this.promptTemplateOverride = args?.promptTemplate;
    this.promptTemplate = null;
  }

  private async loadTemplate(): Promise<string> {
    if (this.promptTemplate !== null) return this.promptTemplate;
    if (this.promptTemplateOverride && this.promptTemplateOverride.trim().length > 0) {
      this.promptTemplate = this.promptTemplateOverride;
      return this.promptTemplate;
    }

    const candidatePaths = [
      this.promptPath,
      resolve(process.cwd(), "phishingdetection_prompt.txt"),
      "/var/task/phishingdetection_prompt.txt",
      "/var/task/netlify/phishingdetection_prompt.txt",
    ];

    const uniqueCandidates = Array.from(new Set(candidatePaths.map((p) => p.trim()).filter(Boolean)));
    const missingErrors: string[] = [];

    for (const path of uniqueCandidates) {
      try {
        this.promptTemplate = await readFile(path, "utf8");
        return this.promptTemplate;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === "ENOENT") {
          missingErrors.push(path);
          continue;
        }
        throw error;
      }
    }

    // eslint-disable-next-line no-console
    console.warn(
      `[ai] prompt file not found in any candidate path (${missingErrors.join(", ")}); using built-in default prompt`,
    );
    this.promptTemplate = DEFAULT_PROMPT_TEMPLATE;
    return this.promptTemplate;
  }

  private async buildPrompt(message: EmailMessage): Promise<string> {
    const template = await this.loadTemplate();
    const emailBlock = buildEmailBlock({
      from: message.from,
      to: message.to,
      subject: message.subject,
      body: message.bodyText,
    });
    return template.includes("$email")
      ? template.replace("$email", emailBlock)
      : `${template}\n\n${emailBlock}`;
  }

  async assess(message: EmailMessage): Promise<PhishingAssessment> {
    const response = await this.client.responses.create({
      model: this.model,
      input: await this.buildPrompt(message),
      text: {
        format: {
          type: "json_schema",
          name: "phishing_assessment",
          strict: true,
          schema: {
            type: "object",
            properties: {
              probability: { type: "number", minimum: 0, maximum: 1 },
              explanation: { type: "string", minLength: 1 },
            },
            required: ["probability", "explanation"],
            additionalProperties: false,
          },
        },
      },
    });

    const raw = response.output_text ?? "";
    const jsonText = extractJsonObject(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("AI response was not valid JSON");
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("probability" in parsed) ||
      !("explanation" in parsed)
    ) {
      throw new Error("AI response JSON missing required fields");
    }

    const probability = clampProbability(Number((parsed as any).probability));
    const explanation = String((parsed as any).explanation ?? "");
    return { probability, explanation };
  }
}
