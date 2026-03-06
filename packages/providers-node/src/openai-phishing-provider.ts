import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EmailMessage, PhishingAiProvider, PhishingAssessment } from "../../body/src/index.js";

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
  private promptTemplate: string | null;

  constructor(args?: { apiKey?: string; model?: string; promptPath?: string }) {
    const apiKey = args?.apiKey ?? process.env.AI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing AI_API_KEY in environment");
    }
    this.client = new OpenAI({ apiKey });
    this.model = args?.model ?? "gpt-5-mini";
    this.promptPath = args?.promptPath ?? resolve(process.cwd(), "phishingdetection_prompt.txt");
    this.promptTemplate = null;
  }

  private async loadTemplate(): Promise<string> {
    if (this.promptTemplate !== null) return this.promptTemplate;
    this.promptTemplate = await readFile(this.promptPath, "utf8");
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
