import { createHash } from 'node:crypto';

export const PLATFORM_LIMITS: Record<string, { maxChars: number; imageRatios: string[] }> = {
  linkedin: { maxChars: 3000, imageRatios: ['1:1', '1.91:1'] },
  x: { maxChars: 280, imageRatios: ['16:9', '1:1'] },
  threads: { maxChars: 500, imageRatios: ['16:9', '1:1'] },
  instagram: { maxChars: 2200, imageRatios: ['4:5', '1:1'] },
};

export const VARIANT_LABELS = ['A', 'B', 'C'];

export type GuardrailResult = {
  ok: boolean;
  score: number;
  violations: string[];
};

export const jsonResponse = (payload: unknown, status: number, corsHeaders: Record<string, string>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

export const normalizeWordList = (input: unknown): string[] => {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  return String(input)
    .split(/[;,\n]/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
};

export const enforcePlatformLength = (platform: string, text: string) => {
  const limit = PLATFORM_LIMITS[platform]?.maxChars;
  if (!limit) return { ok: true, truncated: text };
  if (text.length <= limit) return { ok: true, truncated: text };
  return { ok: false, truncated: text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…' };
};

export const evaluateGuardrails = (params: {
  text: string;
  sourceFacts: string[];
  mustIncludeCta: boolean;
  mustIncludeLink: boolean;
  disallowedWords: string[];
  preferredWords: string[];
}) => {
  const content = params.text.toLowerCase();
  const violations: string[] = [];

  if (params.mustIncludeCta && !/(jetzt|learn more|mehr erfahren|jetzt lesen|discover|testen|demo)/i.test(params.text)) {
    violations.push('cta_missing');
  }

  if (params.mustIncludeLink && !/https?:\/\//i.test(params.text)) {
    violations.push('link_missing');
  }

  const hardClaimPattern = /(garantiert|beweist|100%|sicher|wissenschaftlich bewiesen|always|never|guaranteed|proven)/i;
  if (hardClaimPattern.test(params.text)) {
    const hasSourceHit = params.sourceFacts.some((fact) => fact && content.includes(fact.toLowerCase().slice(0, 20)));
    if (!hasSourceHit) violations.push('unverified_hard_claim');
  }

  if (/(kunde sagt|testimonial|customer says|„.*“)/i.test(params.text) && !/quelle|source|http/i.test(params.text)) {
    violations.push('testimonial_without_source');
  }

  for (const word of params.disallowedWords) {
    if (word && content.includes(word)) violations.push(`disallowed_word:${word}`);
  }

  const preferredMissing = params.preferredWords.filter((word) => word && !content.includes(word));
  const score = Math.max(0, 100 - violations.length * 18 - Math.min(3, preferredMissing.length) * 4);

  return {
    ok: violations.length === 0,
    score,
    violations,
  } satisfies GuardrailResult;
};

export const requestHash = (payload: unknown) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export const estimateTokens = (...parts: string[]) =>
  Math.ceil(parts.join(' ').length / 4);

export const ratioAllowed = (platform: string, ratio: string) =>
  PLATFORM_LIMITS[platform]?.imageRatios.includes(ratio) ?? false;
