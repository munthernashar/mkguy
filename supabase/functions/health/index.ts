import { log } from '../_shared/logger.ts';

const ALLOWED_ORIGINS = new Set<string>([
  'https://mkguy.github.io',
  'https://www.mkguy.github.io',
]);

const buildCorsHeaders = (origin: string | null) => {
  const isAllowed = origin !== null && ALLOWED_ORIGINS.has(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-client-info,apikey',
    Vary: 'Origin',
  };
};

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET') {
    log('warn', 'health_method_not_allowed', { method: request.method, origin });

    return new Response(
      JSON.stringify({ ok: false, error: 'method_not_allowed' }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  const isAllowedOrigin = origin !== null && ALLOWED_ORIGINS.has(origin);
  if (!isAllowedOrigin) {
    log('warn', 'health_origin_denied', { origin });

    return new Response(
      JSON.stringify({ ok: false, error: 'origin_not_allowed' }),
      {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }

  const body = {
    ok: true,
    service: 'health',
    env: Deno.env.get('APP_ENV') ?? 'unknown',
    version: Deno.env.get('APP_VERSION') ?? '0.0.0',
    timestamp: new Date().toISOString(),
  };

  log('info', 'health_ok', { origin, appEnv: body.env, appVersion: body.version });

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
