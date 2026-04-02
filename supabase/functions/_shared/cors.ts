const DEFAULT_ALLOWED_ORIGINS = [
  'https://mkguy.github.io',
  'https://www.mkguy.github.io',
  'https://munthernashar.github.io',
] as const;

const parseAllowedOriginsFromEnv = () => {
  const csv = Deno.env.get('ALLOWED_ORIGINS')?.trim();

  if (!csv) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  const origins = csv
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS;
};

export const ALLOWED_ORIGINS = new Set<string>(parseAllowedOriginsFromEnv());

export const buildCorsHeaders = (origin: string | null) => {
  const isAllowed = origin !== null && ALLOWED_ORIGINS.has(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-client-info,apikey',
    Vary: 'Origin',
  };
};
