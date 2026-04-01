import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { bufferApi, decodeOpaqueToken } from './buffer.ts';

export type MediaInput = { url: string; mime_type?: string; width?: number; height?: number };
export type PublishVia = 'buffer' | 'direct';

export type PlatformCapability = {
  textOnly: boolean;
  media: boolean;
  scheduling: boolean;
  notes: string;
};

export const DIRECT_PLATFORM_CAPABILITIES: Record<string, PlatformCapability> = {
  linkedin: { textOnly: true, media: false, scheduling: false, notes: 'Direct nur Text-only sofort; Media/Scheduling via Buffer.' },
  x: { textOnly: true, media: false, scheduling: false, notes: 'Direct nur Text-only sofort; Media/Scheduling via Buffer.' },
  instagram: { textOnly: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  facebook: { textOnly: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  threads: { textOnly: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  tiktok: { textOnly: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  youtube: { textOnly: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  pinterest: { textOnly: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
  other: { textOnly: false, media: false, scheduling: false, notes: 'Direct Publishing derzeit nicht unterstützt.' },
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

export type PublishResult = {
  status: 'queued' | 'published';
  provider: PublishVia;
  externalId: string | null;
  debug: Record<string, unknown>;
  scheduled: boolean;
};

export class PublishProviderError extends Error {
  code: string;
  retriable: boolean;
  diagnosticPath: string;
  status: number;

  constructor(code: string, message: string, diagnosticPath: string, status = 400, retriable = false) {
    super(message);
    this.code = code;
    this.retriable = retriable;
    this.diagnosticPath = diagnosticPath;
    this.status = status;
  }
}

const ensureOwnership = <T extends { owner_user_id?: string | null }>(row: T | null, userId: string, errorCode: string) => {
  if (!row || row.owner_user_id !== userId) {
    throw new PublishProviderError(errorCode, 'Account not found for user.', `auth/${errorCode}`, 404, false);
  }
};

const publishViaBuffer = async (supabase: SupabaseClient, ctx: PublishContext): Promise<PublishResult> => {
  if (!ctx.profileId) {
    throw new PublishProviderError('buffer_profile_missing', 'Buffer profile is required.', 'buffer/profile_lookup', 422, false);
  }

  const { data: profile } = await supabase.from('buffer_profiles').select('id, external_profile_id, buffer_account_id').eq('id', ctx.profileId).single();
  if (!profile) throw new PublishProviderError('buffer_profile_missing', 'Missing profile.', 'buffer/profile_lookup', 404, false);

  const { data: account } = await supabase.from('buffer_accounts').select('id, owner_user_id, access_token_ref').eq('id', profile.buffer_account_id).single();
  ensureOwnership(account, ctx.userId, 'buffer_account_missing');

  const accessToken = decodeOpaqueToken(account.access_token_ref);
  if (!accessToken) throw new PublishProviderError('buffer_token_missing', 'Buffer token missing.', 'buffer/token_decode', 422, false);

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
    throw new PublishProviderError('direct_platform_account_missing', 'Direct publishing requires platform account.', 'direct/platform_account_lookup', 422, false);
  }

  const { data: account } = await supabase
    .from('platform_accounts')
    .select('id, owner_user_id, platform, auth_status, metadata, access_token_ref, refresh_token_ref')
    .eq('id', ctx.platformAccountId)
    .single();

  ensureOwnership(account, ctx.userId, 'direct_platform_account_missing');
  const capability = DIRECT_PLATFORM_CAPABILITIES[account.platform] ?? DIRECT_PLATFORM_CAPABILITIES.other;

  if (account.auth_status !== 'connected') {
    throw new PublishProviderError('direct_auth_not_connected', 'Platform account is not connected.', 'direct/auth_status', 409, false);
  }

  if (!account.access_token_ref) {
    throw new PublishProviderError('direct_token_missing', 'No direct access token available.', 'direct/token_storage', 422, false);
  }

  if (ctx.scheduledAt && !capability.scheduling) {
    throw new PublishProviderError('direct_scheduling_not_supported', capability.notes, 'direct/capabilities/scheduling', 422, false);
  }

  if (ctx.media.length > 0 && !capability.media) {
    throw new PublishProviderError('direct_media_not_supported', capability.notes, 'direct/capabilities/media', 422, false);
  }

  if (!capability.textOnly) {
    throw new PublishProviderError('direct_platform_not_supported', capability.notes, 'direct/capabilities/platform', 422, false);
  }

  const externalId = `direct_${account.platform}_${crypto.randomUUID()}`;
  return {
    status: 'published',
    provider: 'direct',
    externalId,
    scheduled: false,
    debug: { provider: 'direct', diagnostic_path: 'direct/mock_publish', platform: account.platform },
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
