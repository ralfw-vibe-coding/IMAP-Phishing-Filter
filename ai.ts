import OpenAI from "openai";

export type AiPhishingAssessment = {
  probability: number;
  explanation: string;
};

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

export async function runPhishingAssessmentPrompt(prompt: string): Promise<AiPhishingAssessment> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing AI_API_KEY in environment (.env)");
  }

  const client = new OpenAI({ apiKey });
  const input = prompt;

  const response = await client.responses.create({
    model: "gpt-5-mini",
    input,
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
  } catch (err) {
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
