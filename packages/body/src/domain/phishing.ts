import type { PhishingAssessment } from "../contracts/types.js";

export function clampProbability(probability: number): number {
  if (!Number.isFinite(probability)) return 0;
  if (probability < 0) return 0;
  if (probability > 1) return 1;
  return probability;
}

export function shouldTreatAsPhishing(
  assessment: PhishingAssessment,
  threshold = 0.5,
): boolean {
  return clampProbability(assessment.probability) > threshold;
}
