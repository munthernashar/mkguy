import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { bufferApi, decodeOpaqueToken } from './buffer.ts';

export type MediaInput = { url: string; mime_type?: string; width?: number; height?: number };
export type PublishVia = 'buffer' | 'direct';

export type PlatformCapability = {
  text: boolean;
  media: boolean;
  scheduling: boolean;
  notes: string;
};

export const DIRECT_PLATFORM_CAPABILITIES: Record<string, PlatformCapability> = {
  linkedin: { text: true, media: false, scheduling: false, notes: 'Direct unterstützt nur sofortige Textposts; Media/Scheduling via Buffer.' },
  x: { text: true, media: false, scheduling: false, notes: 'Direct unterstützt nur sofortige Textposts; Media/Scheduling via Buffer.' },
  instagram: { text: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  facebook: { text: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  threads: { text: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  tiktok: { text: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  youtube: { text: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  pinterest: { text: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  other: { text: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
};

export const DIRECT_FALLBACK_TRIGGERS = [
  {
    code: 'missing_buffer_feature_media',
    description: 'Buffer-Profil vorhanden, aber benötigtes Medienformat wird von Buffer nicht abgedeckt.',
  },
  {
    code: 'missing_buffer_feature_platform',
    description: 'Plattform oder Endpoint wird von Buffer funktional nicht unterstützt.',
  },
  {
    code: 'missing_buffer_feature_scheduling_mode',
    description: 'Benötigter Scheduling-Modus ist in Buffer funktional nicht vorhanden.',
  },
] as const;
type DirectFallbackTriggerCode = typeof DIRECT_FALLBACK_TRIGGERS[number]['code'];

export type PublishContext = {
  postId: string;
  text: string;
  media: MediaInput[];
  scheduledAt: string | null;
  platform: string;
  profileId?: string | null;
  platformAccountId?: string | null;
  userId: string;
};

type PlatformAccountRow = {
  id: string;
  owner_user_id?: string | null;
  platform: string;
  external_account_id?: string | null;
  metadata?: Record<string, unknown> | null;
  secure_metadata?: Record<string, unknown> | null;
  is_active?: boolean | null;
  auth_status?: string | null;
  access_token_ref?: string | null;
  refresh_token_ref?: string | null;
  token_expires_at?: string | null;
};

export type PublishResult = {
  status: 'queued' | 'published';
  provider: PublishVia;
  externalId: string | null;
  debug: Record<string, unknown>;
  scheduled: boolean;
};

export class PublishProviderError extends Error {
  code: string;
  category: 'auth' | 'rate_limit' | 'payload' | 'unsupported' | 'upstream';
  retriable: boolean;
  diagnosticPath: string;
  status: number;
  providerStatus?: number;
  providerPayload?: unknown;

  constructor(
    code: string,
    message: string,
    diagnosticPath: string,
    status = 400,
    retriable = false,
    category: PublishProviderError['category'] = 'payload',
    providerStatus?: number,
    providerPayload?: unknown,
  ) {
    super(message);
    this.code = code;
    this.category = category;
    this.retriable = retriable;
    this.diagnosticPath = diagnosticPath;
    this.status = status;
    this.providerStatus = providerStatus;
    this.providerPayload = providerPayload;
  }
}

const ensureOwnership = <T extends { owner_user_id?: string | null }>(row: T | null, userId: string, errorCode: string) => {
  if (!row || row.owner_user_id !== userId) {
    throw new PublishProviderError(errorCode, 'Account not found for user.', `auth/${errorCode}`, 404, false, 'auth');
  }
};

const normalizePlatform = (platform: string) => platform.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const platformCode = (platform: string, suffix: string) => `direct_${normalizePlatform(platform)}_${suffix}`;

const assertActiveDirectAccount = (account: PlatformAccountRow) => {
  if (!account.is_active) {
    throw new PublishProviderError(platformCode(account.platform, 'account_inactive'), 'Platform account is inactive.', 'direct/account_active', 409, false, 'auth');
  }

  if (account.auth_status !== 'connected') {
    const statusSuffix = account.auth_status === 'expired'
      ? 'auth_expired'
      : account.auth_status === 'revoked'
        ? 'auth_revoked'
        : account.auth_status === 'error'
          ? 'auth_error'
          : 'auth_not_connected';
    throw new PublishProviderError(platformCode(account.platform, statusSuffix), 'Platform account is not connected.', 'direct/auth_status', 409, false, 'auth');
  }

  if (!account.access_token_ref) {
    throw new PublishProviderError(platformCode(account.platform, 'token_missing'), 'No direct access token available.', 'direct/token_storage/access', 422, false, 'auth');
  }

  if (!account.refresh_token_ref) {
    throw new PublishProviderError(platformCode(account.platform, 'refresh_token_missing'), 'No direct refresh token available.', 'direct/token_storage/refresh', 422, false, 'auth');
  }

  if (account.token_expires_at && Date.parse(account.token_expires_at) <= Date.now()) {
    throw new PublishProviderError(platformCode(account.platform, 'token_expired'), 'Direct access token is expired.', 'direct/token_expiry', 409, false, 'auth');
  }
};

const requireEnv = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing_env_${name.toLowerCase()}`);
  return value;
};

const safeJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const mapProviderError = (
  platform: string,
  status: number,
  payload: unknown,
  diagnosticPath: string,
): PublishProviderError => {
  if (status === 401 || status === 403) {
    return new PublishProviderError(platformCode(platform, 'auth_failed'), 'Authentication with provider failed.', diagnosticPath, 401, false, 'auth', status, payload);
  }
  if (status === 429) {
    return new PublishProviderError(platformCode(platform, 'rate_limited'), 'Provider rate limit exceeded.', diagnosticPath, 429, true, 'rate_limit', status, payload);
  }
  if (status === 400 || status === 422) {
    return new PublishProviderError(platformCode(platform, 'payload_invalid'), 'Provider rejected payload.', diagnosticPath, 422, false, 'payload', status, payload);
  }
  if (status >= 500) {
    return new PublishProviderError(platformCode(platform, 'provider_unavailable'), 'Provider temporarily unavailable.', diagnosticPath, 502, true, 'upstream', status, payload);
  }
  return new PublishProviderError(platformCode(platform, 'publish_failed'), 'Direct publish failed.', diagnosticPath, 502, false, 'upstream', status, payload);
};

const refreshDirectTokenIfNeeded = async (
  supabase: SupabaseClient,
  account: PlatformAccountRow,
): Promise<{ accessToken: string; refreshToken: string }> => {
  const currentAccessToken = decodeOpaqueToken(account.access_token_ref ?? null);
  const currentRefreshToken = decodeOpaqueToken(account.refresh_token_ref ?? null);

  if (!currentRefreshToken) {
    throw new PublishProviderError(platformCode(account.platform, 'refresh_token_missing'), 'Refresh token missing.', 'direct/token_refresh/missing', 422, false, 'auth');
  }

  const isExpiringSoon = !account.token_expires_at || (Date.parse(account.token_expires_at) - Date.now()) <= 60_000;
  if (currentAccessToken && !isExpiringSoon) {
    return { accessToken: currentAccessToken, refreshToken: currentRefreshToken };
  }

  let tokenResponse: Response;
  if (account.platform === 'linkedin') {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      client_id: requireEnv('LINKEDIN_CLIENT_ID'),
      client_secret: requireEnv('LINKEDIN_CLIENT_SECRET'),
    });
    tokenResponse = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } else if (account.platform === 'x') {
    const clientId = requireEnv('X_CLIENT_ID');
    const clientSecret = requireEnv('X_CLIENT_SECRET');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      client_id: clientId,
    });
    tokenResponse = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body,
    });
  } else {
    throw new PublishProviderError(platformCode(account.platform, 'platform_not_supported'), 'Direct publishing for this platform is not supported.', 'direct/capabilities/platform', 422, false, 'unsupported');
  }

  const tokenPayload = await safeJson(tokenResponse);
  if (!tokenResponse.ok) {
    throw mapProviderError(account.platform, tokenResponse.status, tokenPayload, 'direct/token_refresh');
  }

  const tokenData = tokenPayload as { access_token?: string; refresh_token?: string; expires_in?: number };
  const nextAccessToken = tokenData.access_token;
  const nextRefreshToken = tokenData.refresh_token ?? currentRefreshToken;
  if (!nextAccessToken) {
    throw new PublishProviderError(platformCode(account.platform, 'token_refresh_invalid_response'), 'Token refresh response missing access token.', 'direct/token_refresh/response', 502, false, 'upstream', tokenResponse.status, tokenPayload);
  }

  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;
  await supabase.from('platform_accounts').update({
    access_token_ref: btoa(nextAccessToken),
    refresh_token_ref: btoa(nextRefreshToken),
    token_expires_at: expiresAt,
    auth_status: 'connected',
    secure_metadata: {
      ...(account.secure_metadata ?? {}),
      last_refresh_at: new Date().toISOString(),
    },
  }).eq('id', account.id);

  return { accessToken: nextAccessToken, refreshToken: nextRefreshToken };
};

const publishToLinkedIn = async (accessToken: string, account: PlatformAccountRow, ctx: PublishContext): Promise<string> => {
  const authorUrn = (account.metadata?.member_urn as string | undefined)
    ?? (account.external_account_id ? `urn:li:person:${account.external_account_id}` : null);
  if (!authorUrn) {
    throw new PublishProviderError('direct_linkedin_author_missing', 'LinkedIn author id is missing.', 'direct/linkedin/author', 422, false, 'payload');
  }

  const response = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: ctx.text },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    }),
  });

  const payload = await safeJson(response);
  if (!response.ok) throw mapProviderError('linkedin', response.status, payload, 'direct/linkedin/publish');

  return (payload as { id?: string })?.id ?? response.headers.get('x-restli-id') ?? crypto.randomUUID();
};

const publishToX = async (accessToken: string, ctx: PublishContext): Promise<string> => {
  const response = await fetch('https://api.x.com/2/tweets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: ctx.text }),
  });

  const payload = await safeJson(response);
  if (!response.ok) throw mapProviderError('x', response.status, payload, 'direct/x/publish');

  return (payload as { data?: { id?: string } })?.data?.id ?? crypto.randomUUID();
};

const publishViaBuffer = async (supabase: SupabaseClient, ctx: PublishContext): Promise<PublishResult> => {
  if (!ctx.profileId) {
    throw new PublishProviderError('buffer_profile_missing', 'Buffer profile is required.', 'buffer/profile_lookup', 422, false, 'payload');
  }

  const { data: profile } = await supabase.from('buffer_profiles').select('id, external_profile_id, buffer_account_id').eq('id', ctx.profileId).single();
  if (!profile) throw new PublishProviderError('buffer_profile_missing', 'Missing profile.', 'buffer/profile_lookup', 404, false, 'payload');

  const { data: account } = await supabase.from('buffer_accounts').select('id, owner_user_id, access_token_ref').eq('id', profile.buffer_account_id).single();
  ensureOwnership(account, ctx.userId, 'buffer_account_missing');

  const accessToken = decodeOpaqueToken(account.access_token_ref);
  if (!accessToken) throw new PublishProviderError('buffer_token_missing', 'Buffer token missing.', 'buffer/token_decode', 422, false, 'auth');

  const requestBody: Record<string, unknown> = {
    profile_ids: [profile.external_profile_id],
    text: ctx.text,
    media: ctx.media,
  };
  if (ctx.scheduledAt) requestBody.scheduled_at = ctx.scheduledAt;

  const response = await bufferApi('/updates/create.json', accessToken, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });

  const update = await response.json();
  return {
    status: ctx.scheduledAt ? 'queued' : 'published',
    provider: 'buffer',
    externalId: update?.updates?.[0]?.id ?? update?.id ?? null,
    scheduled: Boolean(ctx.scheduledAt),
    debug: { provider: 'buffer', response: update },
  };
};

const publishDirect = async (supabase: SupabaseClient, ctx: PublishContext): Promise<PublishResult> => {
  if (!ctx.platformAccountId) {
    throw new PublishProviderError('direct_platform_account_missing', 'Direct publishing requires platform account.', 'direct/platform_account_lookup', 422, false, 'payload');
  }

  const { data: account } = await supabase
    .from('platform_accounts')
    .select('id, owner_user_id, platform, external_account_id, is_active, auth_status, metadata, secure_metadata, access_token_ref, refresh_token_ref, token_expires_at')
    .eq('id', ctx.platformAccountId)
    .single();

  ensureOwnership(account, ctx.userId, 'direct_platform_account_missing');
  const capability = DIRECT_PLATFORM_CAPABILITIES[account.platform] ?? DIRECT_PLATFORM_CAPABILITIES.other;
  assertActiveDirectAccount(account);

  if (ctx.platform !== account.platform) {
    throw new PublishProviderError(platformCode(account.platform, 'platform_mismatch'), 'Payload platform does not match direct platform account.', 'direct/platform_validation', 422, false, 'payload');
  }

  if (ctx.scheduledAt && !capability.scheduling) {
    throw new PublishProviderError('direct_scheduling_not_supported', capability.notes, 'direct/capabilities/scheduling', 422, false, 'unsupported');
  }

  if (ctx.media.length > 0 && !capability.media) {
    throw new PublishProviderError('direct_media_not_supported', capability.notes, 'direct/capabilities/media', 422, false, 'unsupported');
  }

  if (!capability.text) {
    throw new PublishProviderError(platformCode(account.platform, 'platform_not_supported'), capability.notes, 'direct/capabilities/platform', 422, false, 'unsupported');
  }

  const { accessToken } = await refreshDirectTokenIfNeeded(supabase, account);
  let externalId: string;
  if (account.platform === 'linkedin') {
    externalId = await publishToLinkedIn(accessToken, account, ctx);
  } else if (account.platform === 'x') {
    externalId = await publishToX(accessToken, ctx);
  } else {
    throw new PublishProviderError(platformCode(account.platform, 'platform_not_supported'), capability.notes, 'direct/capabilities/platform', 422, false, 'unsupported');
  }

  return {
    status: 'published',
    provider: 'direct',
    externalId,
    scheduled: false,
    debug: { provider: 'direct', diagnostic_path: `direct/${account.platform}/publish`, platform: account.platform, external_id: externalId },
  };
};

export const publishWithProvider = async (
  publishVia: PublishVia,
  supabase: SupabaseClient,
  context: PublishContext,
): Promise<PublishResult> => {
  if (publishVia === 'direct') return publishDirect(supabase, context);
  return publishViaBuffer(supabase, context);
};

export const isAllowedDirectFallbackTrigger = (code: string | null | undefined): code is DirectFallbackTriggerCode =>
  Boolean(code) && DIRECT_FALLBACK_TRIGGERS.some((trigger) => trigger.code === code);
