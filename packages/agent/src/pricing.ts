import { TIER_MODEL_ID, type Tier } from './types.ts';

export const PRICING: Record<Tier, { modelId: string; inputPerMTok: number; outputPerMTok: number }> = {
  haiku: { modelId: TIER_MODEL_ID.haiku, inputPerMTok: 0.1, outputPerMTok: 0.5 },
  sonnet: { modelId: TIER_MODEL_ID.sonnet, inputPerMTok: 2, outputPerMTok: 10 },
  opus: { modelId: TIER_MODEL_ID.opus, inputPerMTok: 4, outputPerMTok: 20 },
};

// A server-side fallback can answer with a model outside the ladder, so price it by family.
export function tierOfModel(modelId: string): Tier {
  if (modelId.includes('haiku')) return 'haiku';
  if (modelId.includes('sonnet')) return 'sonnet';
  return 'opus';
}

export function costUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[tierOfModel(modelId)];
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}
