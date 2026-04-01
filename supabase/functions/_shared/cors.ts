export const ALLOWED_ORIGINS = new Set<string>([
  'https://mkguy.github.io',
  'https://www.mkguy.github.io',
]);

export const buildCorsHeaders = (origin: string | null) => {
  const isAllowed = origin !== null && ALLOWED_ORIGINS.has(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-client-info,apikey',
    Vary: 'Origin',
  };
};
