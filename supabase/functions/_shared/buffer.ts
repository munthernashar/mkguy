import { log } from './logger.ts';

export type BufferTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

const requireEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`missing_env_${name.toLowerCase()}`);
  }
  return value;
};

export const getBufferConfig = () => ({
  clientId: requireEnv('BUFFER_CLIENT_ID'),
  clientSecret: requireEnv('BUFFER_CLIENT_SECRET'),
  authorizeUrl: Deno.env.get('BUFFER_AUTHORIZE_URL') ?? 'https://buffer.com/oauth2/authorize',
  tokenUrl: Deno.env.get('BUFFER_TOKEN_URL') ?? 'https://api.bufferapp.com/1/oauth2/token.json',
  apiBaseUrl: Deno.env.get('BUFFER_API_BASE_URL') ?? 'https://api.bufferapp.com/1',
  redirectUri: requireEnv('BUFFER_REDIRECT_URI'),
});

export const encodeOpaqueToken = (raw: string): string => btoa(raw);
export const decodeOpaqueToken = (encoded: string | null): string | null => {
  if (!encoded) return null;
  try {
    return atob(encoded);
  } catch (_error) {
    return null;
  }
};

export const exchangeBufferCode = async (code: string): Promise<BufferTokenResponse> => {
  const cfg = getBufferConfig();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });

  const response = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const payload = await response.text();
    log('warn', 'buffer_exchange_failed', { status: response.status, payload });
    throw new Error('buffer_oauth_exchange_failed');
  }

  return await response.json();
};

export const bufferApi = async (path: string, accessToken: string, init: RequestInit = {}) => {
  const cfg = getBufferConfig();
  const url = `${cfg.apiBaseUrl}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    log('warn', 'buffer_api_failed', { path, status: response.status, payload });
    throw new Error(`buffer_api_failed_${response.status}`);
  }

  return response;
};

export const serviceFromNetwork = (service: string | undefined): string => {
  const value = (service ?? '').toLowerCase();
  if (['linkedin', 'instagram', 'facebook', 'x', 'twitter', 'tiktok', 'youtube', 'threads', 'pinterest'].includes(value)) {
    return value === 'twitter' ? 'x' : value;
  }
  return 'other';
};
