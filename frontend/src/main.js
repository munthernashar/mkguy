import { PUBLIC_CONFIG } from './config.js';
import { logger } from './logger.js';
import { getCurrentView, getParam, getSession, signInWithMagicLink, signOut, exchangeAuthCode, writeAuditLog, buildViewUrl, hasAuthCode, readAuthError, signInWithPassword, signUpWithPassword } from './auth.js';
import { supabase } from './supabaseClient.js';

const app = document.getElementById('app');
const navButtons = document.querySelectorAll('button[data-view]');

const PLATFORM_LIMITS = {
  linkedin: { text: 3000, hashtags: 5, requiresImage: false },
  instagram: { text: 2200, hashtags: 30, requiresImage: true },
  x: { text: 280, hashtags: 3, requiresImage: false },
};

const DIRECT_CAPABILITY_MATRIX = {
  linkedin: { textOnly: true, media: false, scheduling: false },
  instagram: { textOnly: false, media: false, scheduling: false },
  x: { textOnly: true, media: false, scheduling: false },
  facebook: { textOnly: false, media: false, scheduling: false },
  threads: { textOnly: false, media: false, scheduling: false },
  tiktok: { textOnly: false, media: false, scheduling: false },
  youtube: { textOnly: false, media: false, scheduling: false },
  pinterest: { textOnly: false, media: false, scheduling: false },
  other: { textOnly: false, media: false, scheduling: false },
};

const PROFILE_CONNECTION_FLOW = {
  CONNECTED: 'connected',
  EXPIRED: 'expired',
  RECONNECT_REQUIRED: 'reconnect required',
};

const PROVIDER_ERROR_ACTIONS = [
  {
    match: /buffer_token_missing|buffer_token_expired|buffer_auth_invalid|buffer_account_missing|buffer_profile_missing|direct_.*auth_|direct_.*token_|auth_expired|auth_revoked/i,
    action: 'neu verbinden',
    hint: 'Verbindung ist abgelaufen oder fehlt. Bitte über „Buffer verbinden/Reconnect“ erneut autorisieren.',
  },
  {
    match: /direct_platform_account_missing|buffer_profile_missing|profile_not_found|invalid_profile/i,
    action: 'profil neu zuordnen',
    hint: 'Das zugeordnete Profil passt nicht mehr. Bitte Profil-Mapping prüfen und neu zuordnen.',
  },
  {
    match: /direct_requires_functional_gap|missing_buffer_feature_/i,
    action: 'auf buffer wechseln',
    hint: 'Direct ist nur bei funktionalen Buffer-Lücken erlaubt. Fallback-Grund setzen oder publish_via=buffer nutzen.',
  },
  {
    match: /publish_failed|buffer_api_failed_5|buffer_status_poll_failed|timeout|rate_limit|temporar/i,
    action: 'retry später',
    hint: 'Provider aktuell nicht stabil erreichbar. Im Ops-Dashboard Retry ausführen, sobald Verbindung wieder connected ist.',
  },
];

const CTA_HINTS = ['Starte jetzt', 'Kostenlos testen', 'Mehr erfahren', 'Termin buchen'];
const HOOK_HINTS = ['Provokante Frage', 'Statistik als Einstieg', 'Vorher/Nachher', 'Story in 1 Satz'];
const WORKFLOW_STATUSES = ['draft', 'review', 'approved', 'scheduled', 'publishing', 'posted', 'failed', 'archived'];
const STYLE_PRESETS = ['professional', 'storytelling', 'bold', 'educational'];
const IMAGE_ASPECT_RATIOS = {
  linkedin: '1:1',
  instagram: '1:1',
  x: '16:9',
  threads: '1:1',
};
const PREVIEW_LIMITS = {
  linkedin: 3000,
  instagram: 2200,
  x: 280,
  threads: 500,
};

const TRANSITIONS = {
  draft: ['review', 'archived'],
  review: ['draft', 'approved', 'failed', 'archived'],
  approved: ['scheduled', 'archived'],
  scheduled: ['publishing', 'archived'],
  publishing: ['posted', 'failed', 'archived'],
  posted: ['archived'],
  failed: ['draft', 'archived'],
  archived: [],
};

const state = {
  currentRole: null,
  filters: { book: 'all', campaign: 'all', platform: 'all', language: 'all', tag: 'all' },
  selectedId: 'p1',
  roleManagement: {
    users: [],
    auditLogsByUser: {},
    loadError: null,
  },

  buffer: {
    accountId: null,
    accounts: [],
    profiles: [],
    profileMap: {},
    profileConnectionFlow: {},
    profileErrorActions: {},
    debug: null,
    publishVia: 'buffer',
    platformAccounts: [],
  },
  monitor: {
    summary: null,
    deadLetters: { publish: [], generation: [] },
    selectedDetailByType: { publish: null, generation: null },
    filters: {
      publish: { errorCode: 'all', search: '' },
      generation: { errorCode: 'all', search: '' },
    },
    selectedJobs: {
      publish: [],
      generation: [],
    },
  },
  adminWorkspace: {
    settings: null,
    exportFilters: {
      from: '',
      to: '',
      bookId: '',
      campaignId: '',
      platform: '',
    },
  },
  mediaLibrary: {
    assets: [],
  },
  pdfWorkspace: {
    books: [],
    documents: [],
    insights: [],
    selectedBookId: null,
  },
  campaignWorkspace: {
    campaigns: [],
    seriesRules: [],
    evergreenRules: [],
    calendarEvents: [],
    bulkGenerationJobs: [],
    bulkSchedulerJobs: [],
    selectedCampaignId: 'all',
    calendarView: 'month',
    calendarAnchorDate: new Date().toISOString().slice(0, 10),
    calendarFilters: {
      platform: 'all',
      status: 'all',
    },
  },

  posts: [
    {
      id: 'p1',
      title: 'Launch Teaser',
      section: 'Content Studio',
      book: 'Creator Economy 101',
      campaign: 'Q2 Launch',
      platform: 'linkedin',
      language: 'de',
      tags: ['launch', 'education'],
      status: 'draft',
      cta: 'Mehr erfahren',
      hook: 'Wusstest du, dass 72%…?',
      link: 'https://example.com/offer',
      utm: 'utm_source=linkedin&utm_medium=social&utm_campaign=q2_launch',
      hasImage: false,
      variants: [
        { name: 'A', text: 'Unser neues Buch hilft Marketing-Teams in 14 Tagen.', is_selected: false },
        { name: 'B', text: 'So strukturierst du deine Content Pipeline in einer Woche.', is_selected: true },
        { name: 'C', text: 'Weniger Chaos, mehr Output: Das Playbook für Creator.', is_selected: false },
      ],
      hashtags: ['#content', '#marketing', '#creator'],
    },
    {
      id: 'p2',
      title: 'Reel Reminder',
      section: 'Review Inbox',
      book: 'Creator Economy 101',
      campaign: 'Q2 Launch',
      platform: 'instagram',
      language: 'en',
      tags: ['video', 'launch'],
      status: 'review',
      cta: 'Jetzt ansehen',
      hook: 'Stop scrolling: this is your 30-second strategy.',
      link: 'https://example.com/reel',
      utm: 'utm_source=instagram&utm_medium=social&utm_campaign=q2_launch',
      hasImage: true,
      variants: [{ name: 'A', text: 'Your 30-second growth stack for creators.', is_selected: true }],
      hashtags: ['#growth', '#creator'],
    },
    {
      id: 'p3',
      title: 'Evergreen Snippet',
      section: 'Library',
      book: 'B2B Social Copy',
      campaign: 'Evergreen',
      platform: 'x',
      language: 'de',
      tags: ['evergreen'],
      status: 'posted',
      cta: 'Thread lesen',
      hook: '3 Fehler, die fast jedes Team macht:',
      link: 'https://example.com/thread',
      utm: 'utm_source=x&utm_medium=social&utm_campaign=evergreen',
      hasImage: false,
      variants: [{ name: 'A', text: '3 Fehler, die fast jedes Team bei Social macht.', is_selected: true }],
      hashtags: ['#b2b'],
    },
    {
      id: 'p4',
      title: 'Template Set',
      section: 'Media Library',
      book: 'B2B Social Copy',
      campaign: 'Evergreen',
      platform: 'linkedin',
      language: 'en',
      tags: ['template', 'media'],
      status: 'approved',
      cta: 'Vorlage kopieren',
      hook: 'Swipe file for high-converting copy blocks.',
      link: 'https://example.com/templates',
      utm: 'utm_source=linkedin&utm_medium=social&utm_campaign=evergreen',
      hasImage: true,
      variants: [{ name: 'A', text: '10 swipeable frameworks for your next post.', is_selected: true }],
      hashtags: ['#templates', '#copywriting'],
    },
    {
      id: 'p5',
      title: 'Brand Voice Capsule',
      section: 'Brand Kit',
      book: 'Brand Voice Guide',
      campaign: 'Brand Refresh',
      platform: 'linkedin',
      language: 'de',
      tags: ['brand', 'voice'],
      status: 'draft',
      cta: 'Guideline öffnen',
      hook: 'Klingt eure Marke schon konsistent?',
      link: 'https://example.com/brand',
      utm: 'utm_source=linkedin&utm_medium=social&utm_campaign=brand_refresh',
      hasImage: true,
      variants: [{ name: 'A', text: '5 Regeln für einen unverwechselbaren Ton.', is_selected: true }],
      hashtags: ['#brand', '#toneofvoice'],
    },
  ],
};

const LOCAL_SEED_POSTS = state.posts.map((post) => ({ ...post, variants: post.variants.map((variant) => ({ ...variant })) }));

const renderLayout = (html) => {
  app.innerHTML = html;
};

const setActiveNav = (viewName) => {
  navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });
};

const navigate = (viewName, extra = {}) => {
  window.history.pushState({}, '', buildViewUrl(viewName, extra));
  boot();
};

const getUnique = (key) => [...new Set(state.posts.map((p) => p[key]))];

const applyFilters = (post) => Object.entries(state.filters).every(([key, value]) => {
  if (value === 'all') return true;
  if (key === 'tag') return post.tags.includes(value);
  return post[key] === value;
});

const getPost = () => state.posts.find((p) => p.id === state.selectedId) ?? state.posts[0];
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '');
const getGenerationConfig = (post) => ({
  platform: post?.generationConfig?.platform ?? post?.platform ?? 'linkedin',
  language: post?.generationConfig?.language ?? post?.language ?? 'de',
  variants: Number(post?.generationConfig?.variants ?? 2),
  stylePreset: post?.generationConfig?.stylePreset ?? 'professional',
});

const mapDbPostToStudioPost = (dbPost) => {
  const variants = (dbPost.post_variants ?? []).map((variant, index) => ({
    id: variant.id,
    name: variant.metadata?.name ?? String.fromCharCode(65 + index),
    text: variant.content ?? '',
    is_selected: dbPost.selected_variant_id ? dbPost.selected_variant_id === variant.id : index === 0,
    hook: variant.hook_text ?? '',
    cta: variant.cta_text ?? '',
    hashtags: Array.isArray(variant.hashtag_set) ? variant.hashtag_set : [],
    hasImage: Boolean(variant.image_asset_id),
    imageAssetId: variant.image_asset_id ?? null,
    metadata: variant.metadata ?? {},
  }));
  const selectedVariant = variants.find((variant) => variant.is_selected) ?? variants[0];

  return {
    id: dbPost.id,
    title: dbPost.title ?? 'Ohne Titel',
    section: dbPost.section ?? 'Content Studio',
    book: dbPost.book ?? 'Unassigned',
    campaign: dbPost.campaign ?? 'Drafts',
    platform: dbPost.platform ?? 'linkedin',
    language: dbPost.language ?? 'de',
    tags: Array.isArray(dbPost.tags) ? dbPost.tags : [],
    status: dbPost.status ?? 'draft',
    cta: selectedVariant?.cta ?? '',
    hook: selectedVariant?.hook ?? '',
    link: dbPost.destination_url ?? '',
    utm: dbPost.utm_url ?? '',
    utmManualOverride: Boolean(dbPost.utm_manual_override),
    utmProfileId: dbPost.utm_profile_id ?? null,
    hasImage: selectedVariant?.hasImage ?? false,
    variants: variants.length ? variants : [{ name: 'A', text: dbPost.body ?? '', is_selected: true }],
    hashtags: selectedVariant?.hashtags ?? [],
    bookId: dbPost.book_id ?? null,
    campaignId: dbPost.campaign_id ?? null,
    seedId: dbPost.seed_id ?? null,
    generationConfig: getGenerationConfig({ platform: dbPost.platform, language: dbPost.language }),
  };
};

const loadPostsFromDb = async () => {
  const { data, error } = await supabase
    .from('posts')
    .select(`
      id,
      title,
      body,
      status,
      platform,
      language,
      book_id,
      campaign_id,
      seed_id,
      selected_variant_id,
      destination_url,
      utm_url,
      utm_manual_override,
      utm_profile_id,
      post_variants (
        id,
        content,
        hook_text,
        cta_text,
        hashtag_set,
        image_asset_id,
        metadata
      )
    `)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  if (!data?.length) {
    state.posts = LOCAL_SEED_POSTS.map((post) => ({ ...post, variants: post.variants.map((variant) => ({ ...variant })) }));
    state.selectedId = getFallbackSelectedId();
    return;
  }

  state.posts = data.map(mapDbPostToStudioPost);
  await Promise.all(state.posts.filter((post) => isUuid(post.id)).map(async (post) => {
    const { data: generated } = await supabase.rpc('build_post_utm_url', { p_post_id: post.id });
    post.generatedUtmUrl = generated ?? null;
  }));
  state.selectedId = state.posts.some((post) => post.id === state.selectedId) ? state.selectedId : getFallbackSelectedId();
};

const runInitialOnboardingSeed = async () => {
  try {
    const { data, error } = await supabase.rpc('ensure_initial_seed', {
      p_env: PUBLIC_CONFIG.APP_ENV,
    });
    if (error) {
      logger.warn('initial_onboarding_seed_failed', { message: error.message });
      return;
    }
    if (data?.seeded) {
      logger.info('initial_onboarding_seed_created', data);
    }
  } catch (error) {
    logger.warn('initial_onboarding_seed_failed', { message: error.message });
  }
};

const canTransition = (current, target) => TRANSITIONS[current]?.includes(target);

const getPreApprovalChecks = (post) => {
  const selectedVariant = post.variants.find((v) => v.is_selected) ?? post.variants[0];
  const text = selectedVariant?.text?.trim() ?? '';
  const platformCfg = PLATFORM_LIMITS[post.platform] || PLATFORM_LIMITS.linkedin;
  const composedLink = `${post.link}${post.utm ? (post.link.includes('?') ? '&' : '?') + post.utm : ''}`;
  const validLink = /^https?:\/\/.+/.test(post.link) && /^utm_[a-z]+=[^&=]+(?:&utm_[a-z]+=[^&=]+)*$/i.test(post.utm);

  return {
    text: text.length > 0,
    cta: Boolean(post.cta?.trim()),
    validLink,
    platformLength: text.length <= platformCfg.text,
    imageRequired: platformCfg.requiresImage ? post.hasImage : true,
    composedLink,
    textLength: text.length,
    textLimit: platformCfg.text,
  };
};

const mapProviderErrorToAction = (errorCode = '', errorMessage = '') => {
  const search = `${errorCode} ${errorMessage}`.trim();
  const matched = PROVIDER_ERROR_ACTIONS.find((entry) => entry.match.test(search));
  return matched ?? {
    action: 'retry später',
    hint: 'Unbekannter Providerfehler. Bitte Logs prüfen und danach erneut versuchen.',
  };
};

const getProfileConnectionStatus = ({ accountStatus, latestErrorCode, hasMapping }) => {
  if (!hasMapping) return PROFILE_CONNECTION_FLOW.RECONNECT_REQUIRED;
  if (['expired', 'revoked', 'error'].includes(accountStatus)) return PROFILE_CONNECTION_FLOW.EXPIRED;
  if (/token|auth|profile_missing|account_missing/i.test(latestErrorCode ?? '')) return PROFILE_CONNECTION_FLOW.RECONNECT_REQUIRED;
  return PROFILE_CONNECTION_FLOW.CONNECTED;
};

const runPublishPrevalidations = ({ post, publishVia, mappedProfileId, mappedPlatformAccount, scheduledAt }) => {
  const checks = getPreApprovalChecks(post);
  const selectedVariant = post.variants.find((variant) => variant.is_selected) ?? post.variants[0];
  const media = post.hasImage ? [{ url: 'https://picsum.photos/1080/1080.jpg', mime_type: 'image/jpeg', width: 1080, height: 1080 }] : [];
  const directCaps = DIRECT_CAPABILITY_MATRIX[post.platform] ?? { textOnly: false, media: false, scheduling: false };
  const errors = [];

  if (!checks.text) errors.push('Text fehlt.');
  if (!checks.cta) errors.push('CTA fehlt.');
  if (!checks.validLink) errors.push('Link/UTM ungültig.');
  if (!checks.platformLength) errors.push(`Text überschreitet das Plattformlimit (${checks.textLength}/${checks.textLimit}).`);
  if (!checks.imageRequired) errors.push(`Bild ist für ${post.platform} verpflichtend.`);

  if (publishVia === 'buffer' && !mappedProfileId) errors.push(`Kein Buffer-Profil für ${post.platform} gemappt.`);
  if (publishVia === 'direct' && !mappedPlatformAccount) errors.push(`Kein Direct-Account für ${post.platform} verbunden.`);
  if (publishVia === 'direct' && media.length > 0 && !directCaps.media) errors.push(`Nicht unterstützt: direct + Media für ${post.platform}.`);
  if (publishVia === 'direct' && scheduledAt && !directCaps.scheduling) errors.push(`Nicht unterstützt: direct + Scheduling für ${post.platform}.`);

  return {
    ok: errors.length === 0,
    errors,
    selectedVariant,
    media,
  };
};

const hasRolePermission = (action) => {
  if (state.currentRole === 'owner') return true;
  const editorPermissions = ['edit', 'submit_review', 'regenerate_hashtags', 'select_winner', 'archive'];
  if (state.currentRole === 'editor') return editorPermissions.includes(action);
  if (state.currentRole === 'viewer') return false;
  return false;
};

const getFallbackSelectedId = (removedId = null) => {
  const remainingPosts = removedId ? state.posts.filter((post) => post.id !== removedId) : state.posts;
  if (!remainingPosts.length) return null;
  return remainingPosts[0].id;
};

const metricValue = (value) => Number(value ?? 0);
const pct = (value) => `${metricValue(value).toFixed(2)}%`;
const getVariantWinnerReason = (winner, second) => {
  if (!winner) return 'Keine Metrikdaten vorhanden.';
  if (!second) return `Variante ${winner.variant_name} gewinnt mangels Vergleichswert.`;
  if (metricValue(winner.ctr) !== metricValue(second.ctr)) {
    return `Gewinnt über CTR (${pct(winner.ctr)} vs. ${pct(second.ctr)}).`;
  }
  if (metricValue(winner.engagement_rate) !== metricValue(second.engagement_rate)) {
    return `CTR gleich; Engagement entscheidet (${pct(winner.engagement_rate)} vs. ${pct(second.engagement_rate)}).`;
  }
  return 'CTR und Engagement gleich; höhere Impressionen als Tie-Breaker.';
};

const statusPill = (status) => `<span class="status-pill">${status}</span>`;
const escapeHtml = (value = '') => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const truncateText = (value, max) => {
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
};

const parseRatio = (ratio) => {
  const [w, h] = String(ratio ?? '').split(':').map(Number);
  if (!w || !h) return null;
  return w / h;
};

const ratioValidation = (asset, platform) => {
  const required = IMAGE_ASPECT_RATIOS[platform] ?? '1:1';
  const requiredRatio = parseRatio(required);
  const width = Number(asset?.metadata?.width ?? asset?.metadata?.dimensions?.width ?? 0);
  const height = Number(asset?.metadata?.height ?? asset?.metadata?.dimensions?.height ?? 0);
  if (!width || !height || !requiredRatio) {
    return { required, actual: 'unbekannt', ok: false, reason: 'Keine Bildmaße im Asset-Metadatum.' };
  }
  const actual = width / height;
  const delta = Math.abs(actual - requiredRatio);
  const ok = delta < 0.03;
  return {
    required,
    actual: `${width}:${height}`,
    ok,
    reason: ok ? 'Seitenverhältnis passt.' : `Abweichung erkannt (${actual.toFixed(2)} statt ${requiredRatio.toFixed(2)}).`,
  };
};

const renderInsightList = (items) => {
  if (!Array.isArray(items) || !items.length) return '<li class="muted">Keine Einträge.</li>';
  return items.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
};

const classifyAlertBanners = (monitor = {}) => {
  const publishStatus = monitor.publish_status_distribution ?? {};
  const totalPublish = Object.values(publishStatus).reduce((sum, value) => sum + Number(value || 0), 0);
  const failedPublish = Number(publishStatus.failed ?? 0) + Number(publishStatus.dead_letter ?? 0);
  const errorRate = totalPublish > 0 ? failedPublish / totalPublish : 0;
  const topErrors = monitor.top_error_codes ?? [];
  const tokenIncidents = topErrors.filter((item) => /token|auth|profile_missing|account_missing/i.test(item.code ?? '')).reduce((sum, item) => sum + Number(item.count ?? 0), 0);
  const stuckJobs = Number(monitor.stuck_jobs?.publish ?? 0) + Number(monitor.stuck_jobs?.generation ?? 0);
  const alerts = [];
  if (errorRate >= 0.2) alerts.push({ id: 'error-rate', label: `Hohe Error-Rate (${Math.round(errorRate * 100)}%)`, action: 'Dead-Letter prüfen und gezielte Retries ausführen.' });
  if (tokenIncidents > 0) alerts.push({ id: 'token', label: `Token-/Auth-Probleme erkannt (${tokenIncidents})`, action: 'Buffer Connect/Reconnect + Sync ausführen, dann Retry starten.' });
  if (stuckJobs > 0) alerts.push({ id: 'stuck', label: `${stuckJobs} potenziell stuck Jobs`, action: 'recover-stuck-jobs ausführen und Lease/Backoff prüfen.' });
  return alerts;
};

const estimateAttemptHistory = (job) => {
  const attempts = Number(job?.attempts ?? 0);
  if (attempts <= 0) return '<li class="muted">Noch keine Attempts protokolliert.</li>';
  const lines = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const kind = attempt === attempts ? 'letzter Versuch' : 'fehlgeschlagen';
    lines.push(`<li>Attempt ${attempt}/${Math.max(attempts, Number(job?.max_attempts ?? attempts))}: ${kind}</li>`);
  }
  if (job?.next_attempt_at) lines.push(`<li>Backoff bis: <code>${new Date(job.next_attempt_at).toLocaleString()}</code></li>`);
  return lines.join('');
};

const isoDateInputValue = (value) => (value ? new Date(value).toISOString().slice(0, 16) : '');
const parseStringArray = (value, fallback = []) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return fallback;
};
const parseNumericArray = (value, fallback = []) => parseStringArray(value, fallback).map((item) => Number(item)).filter((num) => Number.isFinite(num));
const parseObject = (value, fallback = {}) => (value && typeof value === 'object' && !Array.isArray(value) ? value : fallback);
const startOfDay = (date) => new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
const endOfDay = (date) => new Date(`${date.toISOString().slice(0, 10)}T23:59:59.999Z`);
const getCalendarRange = (view, anchorDateInput) => {
  const anchorDate = new Date(`${anchorDateInput}T12:00:00Z`);
  if (Number.isNaN(anchorDate.getTime())) {
    const now = new Date();
    return { start: startOfDay(now), end: endOfDay(now) };
  }
  if (view === 'day') return { start: startOfDay(anchorDate), end: endOfDay(anchorDate) };
  if (view === 'week') {
    const weekday = anchorDate.getUTCDay();
    const weekStart = new Date(anchorDate);
    weekStart.setUTCDate(anchorDate.getUTCDate() - weekday);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    return { start: startOfDay(weekStart), end: endOfDay(weekEnd) };
  }
  const monthStart = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth() + 1, 0));
  return { start: startOfDay(monthStart), end: endOfDay(monthEnd) };
};

const LoginView = () => `
  <section class="card">
    <h2>Login</h2>
    <p class="muted">Du kannst dich per Magic-Link oder Passwort anmelden.</p>
    <h3>Magic-Link</h3>
    <form id="magic-link-form">
      <label for="magic-email">E-Mail</label><br/>
      <input id="magic-email" name="email" type="email" required placeholder="you@example.com" />
      <div><button id="send-link" type="submit">Magic Link senden</button></div>
    </form>
    <h3>E-Mail + Passwort</h3>
    <form id="password-form">
      <label for="password-email">E-Mail</label><br/>
      <input id="password-email" name="email" type="email" required placeholder="you@example.com"/><br/>
      <label for="password">Passwort</label><br/>
      <input id="password" name="password" type="password" required minlength="8" placeholder="••••••••"/>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button id="password-login" type="submit">Mit Passwort einloggen</button>
        <button id="password-signup" type="button">Account anlegen</button>
      </div>
    </form>
    <p class="muted" id="login-status"></p>
  </section>
`;

const AuthCallbackView = () => `
  <section class="card">
    <h2>Anmeldung wird abgeschlossen…</h2>
    <p class="muted">Bitte warten, du wirst gleich weitergeleitet.</p>
  </section>
`;

const HealthView = (session) => `
  <section class="card">
    <h2>Health view</h2>
    <p>Environment: <code>${PUBLIC_CONFIG.APP_ENV}</code></p>
    <p>Version: <code>${PUBLIC_CONFIG.APP_VERSION}</code></p>
    <p>Supabase URL: <code>${PUBLIC_CONFIG.SUPABASE_URL}</code></p>
    <p>Session: <code>${session?.user?.email ?? 'nicht angemeldet'}</code></p>
    ${session ? '<button id="logout">Logout</button>' : '<p class="muted">Bitte einloggen, um geschützte Seiten zu nutzen.</p>'}
  </section>
`;

const AccessDeniedView = (session) => `
  <section class="card">
    <h2>Kein Zugriff</h2>
    <p>Deinem Account ist aktuell keine Rolle zugewiesen. Bitte kontaktiere einen Owner, damit dir eine Rolle vergeben wird.</p>
    <p class="muted">Angemeldet als: <code>${session?.user?.email ?? 'unbekannt'}</code></p>
  </section>
`;

const StudioView = () => {
  const visiblePosts = state.posts.filter(applyFilters);
  const selected = getPost();
  const checks = getPreApprovalChecks(selected);
  const selectedVariant = selected.variants.find((v) => v.is_selected) ?? selected.variants[0];
  const generationConfig = getGenerationConfig(selected);
  const qualityScore = Number(selectedVariant?.metadata?.quality_score ?? selectedVariant?.metadata?.guardrail_score ?? 0);
  const guardrailViolations = Array.isArray(selectedVariant?.metadata?.violations)
    ? selectedVariant.metadata.violations
    : (Array.isArray(selectedVariant?.metadata?.guardrail_violations) ? selectedVariant.metadata.guardrail_violations : []);
  const guardrailOk = selectedVariant?.metadata?.guardrail_ok ?? (guardrailViolations.length === 0);
  const text = selectedVariant?.text ?? '';
  const limits = PLATFORM_LIMITS[selected.platform] || PLATFORM_LIMITS.linkedin;
  const overLimit = text.length > limits.text;
  const books = state.pdfWorkspace.books ?? [];
  const documents = state.pdfWorkspace.documents ?? [];
  const insights = state.pdfWorkspace.insights ?? [];
  const selectedBookId = state.pdfWorkspace.selectedBookId;
  const selectedBook = books.find((book) => book.id === selectedBookId) ?? books[0] ?? null;
  const bookDocuments = selectedBook ? documents.filter((document) => document.book_id === selectedBook.id) : [];
  const insightsByDocumentId = insights.reduce((acc, insight) => {
    if (!insight.document_id) return acc;
    acc[insight.document_id] = insight;
    return acc;
  }, {});
  const selectedAssetId = selectedVariant?.imageAssetId ?? null;
  const selectedAsset = state.mediaLibrary.assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const ratioCheck = selectedAsset ? ratioValidation(selectedAsset, selected.platform) : null;
  const previewLimit = PREVIEW_LIMITS[selected.platform] ?? 280;
  const campaigns = state.campaignWorkspace.campaigns ?? [];
  const selectedCampaignId = state.campaignWorkspace.selectedCampaignId;
  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? null;
  const mappedBufferProfileId = state.buffer.profileMap[selected.platform] ?? null;
  const profileConnectionFlow = state.buffer.profileConnectionFlow[selected.platform] ?? PROFILE_CONNECTION_FLOW.RECONNECT_REQUIRED;
  const profileErrorAction = state.buffer.profileErrorActions[selected.platform] ?? null;
  const selectedSeriesRule = state.campaignWorkspace.seriesRules.find((rule) => rule.campaign_id === selectedCampaignId) ?? null;
  const utmGeneratedUrl = selected.generatedUtmUrl ?? checks.composedLink;
  const utmValidationMessages = [];
  if (!/^https?:\/\/.+/i.test(selected.link ?? '')) utmValidationMessages.push('Basis-URL fehlt oder ist ungültig.');
  if (selected.utmManualOverride && !/^utm_[a-z]+=[^&=]+(?:&utm_[a-z]+=[^&=]+)*$/i.test(selected.utm ?? '')) utmValidationMessages.push('UTM-Override muss key=value Paare mit utm_ Präfix enthalten.');
  const utmSourceLabel = selected.utmManualOverride ? 'Manual Override' : `Auto (Rule/Profile${selected.utmProfileId ? ' + Profile' : ' ohne Profile-Override'})`;
  const activePlatformMix = parseStringArray(selectedCampaign?.platform_mix, []);
  const cadence = parseObject(selectedCampaign?.cadence, {});
  const calendarRange = getCalendarRange(state.campaignWorkspace.calendarView, state.campaignWorkspace.calendarAnchorDate);
  const calendarEvents = (state.campaignWorkspace.calendarEvents ?? []).filter((event) => {
    const startsAt = new Date(event.starts_at);
    if (Number.isNaN(startsAt.getTime())) return false;
    if (selectedCampaignId !== 'all' && event.campaign_id !== selectedCampaignId) return false;
    if (state.campaignWorkspace.calendarFilters.platform !== 'all' && event.platform !== state.campaignWorkspace.calendarFilters.platform) return false;
    if (state.campaignWorkspace.calendarFilters.status !== 'all' && event.status !== state.campaignWorkspace.calendarFilters.status) return false;
    return startsAt >= calendarRange.start && startsAt <= calendarRange.end;
  });
  const evergreenRules = (state.campaignWorkspace.evergreenRules ?? []).filter((rule) => (
    selectedCampaignId === 'all' ? true : rule.campaign_id === selectedCampaignId
  ));

  return `
    <section class="card">
      <h3>Buchanlage & PDF-Analyse</h3>
      <form id="book-create-form" class="grid">
        <label>Titel
          <input id="book-title" required placeholder="Buchtitel" />
        </label>
        <label>Beschreibung
          <input id="book-description" placeholder="Kurze Beschreibung" />
        </label>
        <div style="display:flex;align-items:end;">
          <button type="submit">Buch anlegen</button>
        </div>
      </form>
      <div class="inline-actions">
        <label>Buch auswählen
          <select id="book-select">
            ${books.map((book) => `<option value="${book.id}" ${selectedBook?.id === book.id ? 'selected' : ''}>${escapeHtml(book.title ?? 'Ohne Titel')}</option>`).join('')}
          </select>
        </label>
      </div>
      ${!selectedBook ? '<p class="muted">Lege zuerst ein Buch an, um PDFs hochzuladen.</p>' : `
        <form id="pdf-upload-form" class="inline-actions">
          <input id="pdf-file" type="file" accept="application/pdf" required />
          <button type="submit">PDF in Storage-Bucket hochladen</button>
        </form>
      `}
      <h4>Dokumentstatus</h4>
      ${bookDocuments.map((document) => {
    const insight = insightsByDocumentId[document.id];
    return `
          <div class="list-item">
            <div><strong>${escapeHtml(document.file_name ?? 'Unbekanntes Dokument')}</strong> ${statusPill(document.parse_status ?? 'uploaded')}</div>
            <div class="muted">Status: <code>${document.parse_status ?? 'uploaded'}</code> • Hochgeladen: ${new Date(document.created_at).toLocaleString()}</div>
            ${document.parse_error ? `<div class="danger">Parse-Fehler: ${escapeHtml(document.parse_error)}</div>` : ''}
            <div class="inline-actions">
              <button data-start-analysis="${document.id}">Analyse starten</button>
              <button data-reanalyze="${document.id}">Neu analysieren</button>
            </div>
            ${insight ? `
              <div>
                <h5>book_insights</h5>
                <p><strong>Short Summary:</strong> ${escapeHtml(insight.summary_short ?? '—')}</p>
                <p><strong>Long Summary:</strong> ${escapeHtml(insight.summary_long ?? insight.content ?? '—')}</p>
                <strong>Key Topics</strong>
                <ul>${renderInsightList(insight.key_topics)}</ul>
                <strong>Quotes</strong>
                <ul>${renderInsightList(insight.quote_candidates)}</ul>
                <strong>Content Seeds</strong>
                <ul>${renderInsightList(insight.content_seeds)}</ul>
              </div>
            ` : '<p class="muted">Noch keine Insights vorhanden.</p>'}
          </div>
        `;
  }).join('') || '<p class="muted">Keine Dokumente für dieses Buch.</p>'}
    </section>

    <section class="card">
      <h2>Frontend Arbeitsbereiche</h2>
      <div class="toolbar">
        <span class="muted">Aktive Rolle: <strong>${state.currentRole ?? 'keine'}</strong></span>
      </div>
      <div class="grid">
        ${['book', 'campaign', 'platform', 'language', 'tag'].map((key) => `
          <label>${key}
            <select data-filter="${key}">
              <option value="all">all</option>
              ${getUnique(key === 'tag' ? 'tags' : key).flat().map((v) => `<option value="${v}" ${state.filters[key] === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
        `).join('')}
      </div>
    </section>

    <section class="card split">
      <div>
        <div class="inline-actions">
          <h3>Content Studio</h3>
          <button id="create-post">Neuer Post</button>
        </div>
        <p class="muted">Editor mit Varianten A/B/C, Zeichenzähler, CTA-/Hook-Hinweisen und Freigabechecks.</p>
        ${visiblePosts.filter((post) => post.status !== 'archived').map((post) => `
          <div class="list-item">
            <strong>${post.title}</strong> ${statusPill(post.status)}
            <div class="muted">${post.section} • ${post.book} • ${post.campaign} • ${post.platform} • ${post.language}</div>
            <div class="inline-actions">
              <button data-open="${post.id}">Öffnen</button>
              <button data-archive="${post.id}">Archivieren</button>
              <span class="muted">Tags: ${post.tags.join(', ')}</span>
            </div>
          </div>
        `).join('')}
      </div>

      <div>
        <h3>Review Inbox</h3>
        ${visiblePosts.filter((p) => p.status === 'review').map((p) => `<div class="list-item">${p.title} ${statusPill(p.status)}</div>`).join('') || '<p class="muted">Keine Elemente im Review.</p>'}
        <h3>Library</h3>
        ${visiblePosts.filter((p) => ['posted', 'archived'].includes(p.status)).map((p) => `<div class="list-item">${p.title} ${statusPill(p.status)}</div>`).join('') || '<p class="muted">Keine Library-Elemente.</p>'}
        <h3>Media Library</h3>
        ${visiblePosts.filter((p) => p.section === 'Media Library').map((p) => `<div class="list-item">${p.title} ${p.hasImage ? '🖼️' : '—'}</div>`).join('') || '<p class="muted">Keine Medien.</p>'}
        <h3>Brand Kit</h3>
        ${visiblePosts.filter((p) => p.section === 'Brand Kit').map((p) => `<div class="list-item">${p.title}</div>`).join('') || '<p class="muted">Keine Brand-Kit-Einträge.</p>'}
      </div>
    </section>

    <section class="card">
      <h3>Editor: ${selected.title}</h3>
      <div class="grid">
        <label>Hook <input id="hook-input" value="${selected.hook}" /></label>
        <label>CTA <input id="cta-input" value="${selected.cta}" /></label>
        <label>Link <input id="link-input" value="${selected.link}" /></label>
        <label>UTM <input id="utm-input" value="${selected.utm}" /></label>
      </div>
      <div class="card">
        <h4>UTM Transparenz</h4>
        <p class="muted">Quelle: <code>${utmSourceLabel}</code>${selected.utmProfileId ? ` • Profil: <code>${selected.utmProfileId}</code>` : ''}</p>
        <p class="muted">Erzeugte URL: <code>${escapeHtml(utmGeneratedUrl ?? '—')}</code></p>
        <p class="${utmValidationMessages.length ? 'danger' : 'muted'}">Validierung: ${utmValidationMessages.length ? utmValidationMessages.join(' ') : 'OK'}</p>
      </div>
      <p class="hint">Hook-Hinweise: ${HOOK_HINTS.join(' • ')}</p>
      <p class="hint">CTA-Hinweise: ${CTA_HINTS.join(' • ')}</p>
      <div class="inline-actions">
        ${selected.variants.map((v, idx) => `<button data-variant="${idx}">${v.name}${v.is_selected ? ' ✅' : ''}</button>`).join('')}
        <button id="add-variant">Variante manuell anlegen</button>
      </div>
      <h4>KI-Aktionen</h4>
      <div class="grid">
        <label>Plattform
          <select id="ai-platform">
            ${['linkedin', 'instagram', 'x', 'threads'].map((platform) => `<option value="${platform}" ${generationConfig.platform === platform ? 'selected' : ''}>${platform}</option>`).join('')}
          </select>
        </label>
        <label>Sprache
          <select id="ai-language">
            ${['de', 'en'].map((language) => `<option value="${language}" ${generationConfig.language === language ? 'selected' : ''}>${language}</option>`).join('')}
          </select>
        </label>
        <label>Variantenanzahl
          <input id="ai-variant-count" type="number" min="1" max="3" value="${generationConfig.variants}" />
        </label>
        <label>Stilpreset
          <select id="ai-style-preset">
            ${STYLE_PRESETS.map((preset) => `<option value="${preset}" ${generationConfig.stylePreset === preset ? 'selected' : ''}>${preset}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="inline-actions">
        <button id="generate-text">Text generieren</button>
        <button id="generate-hashtags">Hashtags generieren</button>
        <button id="generate-image">Bild generieren</button>
        <button id="quality-check">Qualität prüfen</button>
      </div>
      ${!guardrailOk ? `<div class="danger">Guardrail-Warnung: ${guardrailViolations.map((v) => escapeHtml(String(v))).join(' • ') || 'Prüfung fehlgeschlagen'}</div>` : ''}
      ${qualityScore > 0 && qualityScore < 70 ? `<div class="danger">Quality-Warnung: Score ${qualityScore}/100. Bitte Hook/CTA/Faktenlage überarbeiten.</div>` : ''}
      <textarea id="variant-text" rows="5">${text}</textarea>
      <div class="inline-actions">
        <span class="${overLimit ? 'danger' : 'muted'}">${text.length}/${limits.text} Zeichen (${selected.platform})</span>
        <button id="save-editor">Text speichern</button>
        <button id="pick-winner">Gewinner markieren (is_selected)</button>
      </div>

      <h4>Post-Preview (${selected.platform})</h4>
      <div class="card">
        <p><strong>${escapeHtml(selected.hook || 'Hook')}</strong></p>
        <p>${escapeHtml(truncateText(text, previewLimit))}</p>
        <p class="muted">${selected.hashtags.map((tag) => escapeHtml(tag)).join(' ')}</p>
        ${selectedAsset ? `<p class="muted">Asset: <code>${selectedAsset.storage_path}</code> (${selectedAsset.mime_type ?? 'n/a'})</p>` : '<p class="muted">Kein Asset verknüpft.</p>'}
        <p class="${text.length > previewLimit ? 'danger' : 'muted'}">Länge in Vorschau: ${Math.min(text.length, previewLimit)}/${previewLimit}</p>
      </div>

      <h4>Media Library Workflow</h4>
      <div class="grid">
        <label>Asset auswählen/ersetzen
          <select id="media-asset-select">
            <option value="">Kein Asset</option>
            ${state.mediaLibrary.assets.filter((asset) => asset.asset_type === 'image').map((asset) => `<option value="${asset.id}" ${asset.id === selectedAssetId ? 'selected' : ''}>${asset.storage_path}</option>`).join('')}
          </select>
        </label>
        <label>Alt-Text
          <input id="media-alt-text" value="${escapeHtml(selectedAsset?.metadata?.alt_text ?? '')}" placeholder="Beschreibender Alt-Text" />
        </label>
      </div>
      <div class="grid">
        <label>Neues Asset: Storage Path
          <input id="new-media-path" placeholder="generated/post-123/image.png" />
        </label>
        <label>MIME-Type
          <input id="new-media-mime" value="image/png" />
        </label>
        <label>Breite
          <input id="new-media-width" type="number" min="1" placeholder="1080" />
        </label>
        <label>Höhe
          <input id="new-media-height" type="number" min="1" placeholder="1080" />
        </label>
      </div>
      <div class="inline-actions">
        <button id="media-link-asset">Asset verknüpfen</button>
        <button id="media-replace-asset">Asset ersetzen (neu anlegen)</button>
        <button id="media-save-alt">Alt-Text speichern</button>
      </div>
      ${ratioCheck ? `<p class="${ratioCheck.ok ? 'muted' : 'danger'}">Ratio-Validierung (${selected.platform}): Soll ${ratioCheck.required}, Ist ${ratioCheck.actual} — ${ratioCheck.reason}</p>` : '<p class="danger">Ratio-Validierung: kein Asset oder keine Maße verfügbar.</p>'}

      <h4>Workflow</h4>
      <div class="inline-actions">
        ${WORKFLOW_STATUSES.filter((s) => s !== selected.status).map((status) => `<button data-transition="${status}">${status}</button>`).join('')}
        <button data-archive="${selected.id}">Archivieren</button>
        <button data-delete="${selected.id}">Löschen</button>
      </div>
      ${selected.status === 'review' ? `
        <h4>Review-Aktionen</h4>
        <div class="inline-actions">
          <button id="review-approve">Approve</button>
          <button id="review-back-to-draft">Zurück zu Draft</button>
          <button id="review-duplicate">Duplizieren</button>
          <button id="review-adopt-series">In Serie übernehmen</button>
        </div>
      ` : ''}
      <p class="muted">Erlaubte Folgestati von <code>${selected.status}</code>: ${(TRANSITIONS[selected.status] || []).join(', ') || 'keine'}</p>

      <h4>Hashtag Panel</h4>
      <input id="hashtags-input" value="${selected.hashtags.join(', ')}" />
      <div class="inline-actions">
        <button id="regen-hashtags">Hashtags regenerieren</button>
        <button id="sort-hashtags">Manuelle Reihenfolge übernehmen</button>
        <span class="muted">Limit ${limits.hashtags} für ${selected.platform}</span>
      </div>

      <h4>Pflichtchecks vor approved</h4>
      <ul>
        <li>Text vorhanden: ${checks.text ? '✅' : '❌'}</li>
        <li>CTA vorhanden: ${checks.cta ? '✅' : '❌'}</li>
        <li>Valider Link + UTM: ${checks.validLink ? '✅' : '❌'}</li>
        <li>Plattformlänge ok: ${checks.platformLength ? '✅' : '❌'} (${checks.textLength}/${checks.textLimit})</li>
        <li>Bildpflicht erfüllt: ${checks.imageRequired ? '✅' : '❌'}</li>
      </ul>
      <p class="muted">Composed URL: <code>${checks.composedLink}</code></p>
      <p class="muted">Rollenrechte: editor = bearbeiten/review/hashtag/winner; owner = volle Freigabe + Scheduling/Publishing.</p>

      <h4>Buffer Connect & Mapping</h4>
      <div class="inline-actions">
        <button id="buffer-connect">Buffer verbinden</button>
        <button id="buffer-reconnect">Reconnect</button>
        <button id="buffer-sync">sync-buffer-profiles</button>
      </div>
      <p class="muted">Account-Status: ${state.buffer.accounts[0]?.access_status ?? 'nicht verbunden'} • Profilstatus (${selected.platform}): <strong>${profileConnectionFlow}</strong></p>
      <p class="muted">Statusflow: connected → expired → reconnect required (pro Plattformprofil).</p>
      ${mappedBufferProfileId ? `<p class="muted">Gemapptes Buffer-Profil: <code>${mappedBufferProfileId}</code></p>` : '<p class="danger">Kein Profil gemappt: reconnect required.</p>'}
      ${profileErrorAction ? `<p class="danger">Provider-Hinweis: <strong>${profileErrorAction.action}</strong> — ${profileErrorAction.hint}</p>` : '<p class="muted">Keine aktuellen Providerfehler für dieses Plattformprofil.</p>'}
      <label>Profil-Mapping (${selected.platform})
        <select id="buffer-profile-map">
          <option value="">Kein Profil</option>
          ${state.buffer.profiles.filter((p) => p.service === selected.platform).map((p) => `<option value="${p.id}" ${state.buffer.profileMap[selected.platform] === p.id ? 'selected' : ''}>${p.profile_name} (${p.service})</option>`).join('')}
        </select>
      </label>
      <label>publish_via
        <select id="publish-via">
          <option value="buffer" ${state.buffer.publishVia === 'buffer' ? 'selected' : ''}>buffer</option>
          <option value="direct" ${state.buffer.publishVia === 'direct' ? 'selected' : ''}>direct</option>
        </select>
      </label>
      <p class="muted">Direkt-Account (${selected.platform}): ${state.buffer.platformAccounts.find((account) => account.platform === selected.platform)?.account_name ?? 'nicht verbunden'}</p>
      <div class="inline-actions">
        <button id="buffer-publish-now">publish-via-buffer jetzt</button>
        <button id="buffer-publish-scheduled">publish-via-buffer geplant (+15m)</button>
      </div>
      <h4>Direct-Fallback Minimum je Plattform</h4>
      <ul>
        ${Object.entries(DIRECT_CAPABILITY_MATRIX).map(([platform, caps]) => `<li><strong>${platform}</strong>: text-only=${caps.textOnly ? '✅' : '❌'}, media=${caps.media ? '✅' : '❌'}, scheduling=${caps.scheduling ? '✅' : '❌'}</li>`).join('')}
      </ul>
      ${state.buffer.publishVia === 'direct' && selected.hasImage ? '<p class="danger">Nicht unterstützt: Media-Post via direct für diese Plattform.</p>' : ''}
      ${state.buffer.publishVia === 'direct' ? '<p class="muted">Direct wird nur bei funktionalen Lücken verwendet (z. B. Media/Scheduling-Support fehlt in Buffer), nicht bei temporären Buffer-Fehlern.</p>' : ''}

      <h4>Debugpanel</h4>
      <ul>
        <li>Provider: <code>${state.buffer.debug?.provider ?? 'buffer'}</code></li>
        <li>Update-ID: <code>${state.buffer.debug?.buffer_update_id ?? '—'}</code></li>
        <li>Attempts: <code>${state.buffer.debug?.attempts ?? '—'}</code></li>
        <li>Letzter Fehler: <code>${state.buffer.debug?.last_error ?? '—'}</code></li>
      </ul>
      <h4>Monitoring</h4>
      <p class="muted">Monitoring wurde in den separaten Ops-Bereich ausgelagert: dort findest du Filter, Dead-Letter-Batches und Detailansichten für Publish/Generation.</p>
      <div class="inline-actions">
        <button id="open-ops">Ops öffnen</button>
      </div>
      <p id="studio-status" class="muted"></p>
    </section>

    <section class="card">
      <h3>Kampagnen-UI: one_off/series + Cadence + Plattformmix</h3>
      <div class="grid">
        <label>Kampagne
          <select id="campaign-workspace-select">
            <option value="all">Alle Kampagnen</option>
            ${campaigns.map((campaign) => `<option value="${campaign.id}" ${selectedCampaignId === campaign.id ? 'selected' : ''}>${escapeHtml(campaign.name)}</option>`).join('')}
          </select>
        </label>
        <label>Neue Kampagne
          <input id="campaign-create-name" placeholder="Q3 Awareness Push" />
        </label>
        <div style="display:flex;align-items:end;"><button id="campaign-create">Kampagne anlegen</button></div>
      </div>
      ${selectedCampaign ? `
        <div class="grid">
          <label>Name <input id="campaign-name" value="${escapeHtml(selectedCampaign.name ?? '')}" /></label>
          <label>Typ
            <select id="campaign-type">
              ${['one_off', 'series'].map((type) => `<option value="${type}" ${selectedCampaign.campaign_type === type ? 'selected' : ''}>${type}</option>`).join('')}
            </select>
          </label>
          <label>Objective <input id="campaign-objective" value="${escapeHtml(selectedCampaign.objective ?? '')}" placeholder="Awareness / Leads / Sales" /></label>
          <label>CTA-Ziel <input id="campaign-cta-goal" value="${escapeHtml(selectedCampaign.cta_goal ?? '')}" placeholder="Terminbuchung" /></label>
          <label>Zeitraum Start <input id="campaign-period-start" type="datetime-local" value="${isoDateInputValue(selectedCampaign.period_starts_at)}" /></label>
          <label>Zeitraum Ende <input id="campaign-period-end" type="datetime-local" value="${isoDateInputValue(selectedCampaign.period_ends_at)}" /></label>
        </div>
        <label>Summary <textarea id="campaign-summary" rows="2">${escapeHtml(selectedCampaign.summary ?? '')}</textarea></label>
        <h4>Cadence-Definition</h4>
        <div class="grid">
          <label>Intervall
            <input id="campaign-cadence-interval" type="number" min="1" value="${Number(cadence.interval ?? 1)}" />
          </label>
          <label>Einheit
            <select id="campaign-cadence-unit">
              ${['day', 'week', 'month'].map((unit) => `<option value="${unit}" ${cadence.unit === unit ? 'selected' : ''}>${unit}</option>`).join('')}
            </select>
          </label>
          <label>Wochentage (0-6 CSV)
            <input id="campaign-cadence-weekdays" value="${parseNumericArray(cadence.weekdays, []).join(',')}" placeholder="1,3,5" />
          </label>
          <label>Times (HH:mm CSV)
            <input id="campaign-cadence-times" value="${parseStringArray(cadence.times, []).join(',')}" placeholder="09:00,15:00" />
          </label>
        </div>
        <h4>Plattformmix</h4>
        <div class="inline-actions">
          ${['linkedin', 'instagram', 'x', 'threads', 'youtube'].map((platform) => `
            <label><input type="checkbox" data-platform-mix="${platform}" ${activePlatformMix.includes(platform) ? 'checked' : ''}/> ${platform}</label>
          `).join('')}
        </div>
        <h4>Series-Regel</h4>
        <div class="grid">
          <label>Allowed weekdays CSV <input id="series-weekdays" value="${parseNumericArray(selectedSeriesRule?.allowed_weekdays, [1, 2, 3, 4, 5]).join(',')}" /></label>
          <label>Allowed times CSV <input id="series-times" value="${parseStringArray(selectedSeriesRule?.allowed_times, ['09:00']).join(',')}" /></label>
          <label>Timezone <input id="series-timezone" value="${escapeHtml(selectedSeriesRule?.timezone ?? 'UTC')}" /></label>
        </div>
        <div class="inline-actions">
          <button id="campaign-save">Kampagne speichern</button>
          <button id="series-save">Series-Regel speichern</button>
        </div>
      ` : '<p class="muted">Wähle eine Kampagne, um Felder zu bearbeiten.</p>'}
    </section>

    <section class="card">
      <h3>Kalender (Monat/Woche/Tag) + Filter + Terminverschiebung + Konfliktwarnungen</h3>
      <div class="grid">
        <label>Ansicht
          <select id="calendar-view">
            ${['month', 'week', 'day'].map((view) => `<option value="${view}" ${state.campaignWorkspace.calendarView === view ? 'selected' : ''}>${view}</option>`).join('')}
          </select>
        </label>
        <label>Ankerdatum <input id="calendar-anchor-date" type="date" value="${state.campaignWorkspace.calendarAnchorDate}" /></label>
        <label>Plattform-Filter
          <select id="calendar-filter-platform">
            <option value="all">all</option>
            ${['linkedin', 'instagram', 'x', 'threads', 'youtube'].map((platform) => `<option value="${platform}" ${state.campaignWorkspace.calendarFilters.platform === platform ? 'selected' : ''}>${platform}</option>`).join('')}
          </select>
        </label>
        <label>Status-Filter
          <select id="calendar-filter-status">
            <option value="all">all</option>
            ${['scheduled', 'rescheduled', 'cancelled', 'published'].map((eventStatus) => `<option value="${eventStatus}" ${state.campaignWorkspace.calendarFilters.status === eventStatus ? 'selected' : ''}>${eventStatus}</option>`).join('')}
          </select>
        </label>
      </div>
      ${calendarEvents.map((event) => `
        <div class="list-item ${Array.isArray(event.conflict_flags) && event.conflict_flags.length ? 'calendar-conflict' : ''}">
          <strong>${new Date(event.starts_at).toLocaleString()}</strong> • ${event.platform} ${statusPill(event.status)}
          <div class="muted">Event: <code>${event.id}</code> • Post: <code>${event.post_id}</code></div>
          <div class="inline-actions">
            <input type="datetime-local" data-reschedule-at="${event.id}" value="${isoDateInputValue(event.starts_at)}" />
            <button data-reschedule-event="${event.id}" data-reschedule-post="${event.post_id}" data-reschedule-platform="${event.platform}" data-reschedule-campaign="${event.campaign_id ?? ''}">Termin verschieben</button>
          </div>
          ${Array.isArray(event.conflict_flags) && event.conflict_flags.length ? `<div class="danger">Konflikte: ${event.conflict_flags.map((flag) => `<code>${escapeHtml(String(flag))}</code>`).join(' ')}</div>` : '<div class="muted">Keine Konflikte.</div>'}
        </div>
      `).join('') || '<p class="muted">Keine Events im gewählten Zeitfenster.</p>'}
    </section>

    <section class="card">
      <h3>Bulk-Generator / Bulk-Scheduler</h3>
      <div class="grid">
        <label>Requested Count <input id="bulk-generation-count" type="number" min="1" max="500" value="10" /></label>
        <label>Generation Brief <input id="bulk-generation-brief" placeholder="10 Varianten für Webinar-Serie" /></label>
        <label>Optionen (JSON) <input id="bulk-generation-options" value='{"platforms":["linkedin","x"]}' /></label>
      </div>
      <button id="bulk-generation-create">Bulk-Generator-Job anlegen</button>
      <div class="grid" style="margin-top:0.75rem;">
        <label>Window Start <input id="bulk-scheduler-start" type="datetime-local" /></label>
        <label>Window End <input id="bulk-scheduler-end" type="datetime-local" /></label>
        <label>Plattform <input id="bulk-scheduler-platform" value="linkedin" /></label>
        <label>Max/Tag <input id="bulk-scheduler-max-per-day" type="number" min="1" value="3" /></label>
        <label>Timezone <input id="bulk-scheduler-timezone" value="UTC" /></label>
        <label>Optionen (JSON) <input id="bulk-scheduler-options" value='{"respect_conflicts":true}' /></label>
      </div>
      <button id="bulk-scheduler-create">Bulk-Scheduler-Job anlegen</button>
      <h4>Zuletzt erzeugte Jobs</h4>
      ${(state.campaignWorkspace.bulkGenerationJobs ?? []).slice(0, 5).map((job) => `<div class="muted">Generation: ${job.requested_count} • ${job.status} • ${new Date(job.created_at).toLocaleString()}</div>`).join('')}
      ${(state.campaignWorkspace.bulkSchedulerJobs ?? []).slice(0, 5).map((job) => `<div class="muted">Scheduler: ${job.platform ?? 'all'} ${job.status} • ${new Date(job.created_at).toLocaleString()}</div>`).join('')}
    </section>

    <section class="card">
      <h3>Evergreen-Regelverwaltung (Persistenz)</h3>
      <div class="grid">
        <label>Plattform <input id="evergreen-platform" value="linkedin" /></label>
        <label>Mindestabstand Tage <input id="evergreen-spacing" type="number" min="1" value="14" /></label>
        <label>Variantenwechsel
          <select id="evergreen-rotation">
            ${['round_robin', 'least_recent', 'random'].map((mode) => `<option value="${mode}">${mode}</option>`).join('')}
          </select>
        </label>
        <label>KPI-Metrik <input id="evergreen-kpi-metric" placeholder="ctr" /></label>
        <label>KPI-Schwelle <input id="evergreen-kpi-threshold" type="number" step="0.01" placeholder="1.2" /></label>
      </div>
      <button id="evergreen-save">Evergreen-Regel speichern</button>
      ${evergreenRules.map((rule) => `
        <div class="list-item">
          <strong>${rule.platform}</strong> • Abstand ${rule.min_spacing_days} Tage • Rotation ${rule.variant_rotation}
          <div class="muted">KPI: ${rule.min_kpi_metric ?? '—'} ≥ ${rule.min_kpi_threshold ?? '—'} • Status: ${rule.status}</div>
        </div>
      `).join('') || '<p class="muted">Keine Evergreen-Regeln für den Filter.</p>'}
    </section>
  `;
};

const OpsView = () => {
  const monitor = state.monitor.summary ?? {};
  const alerts = classifyAlertBanners(monitor);
  const adminSettings = state.adminWorkspace.settings ?? {};
  const limits = parseObject(adminSettings.global_limits, {});
  const toggles = parseObject(adminSettings.feature_toggles, {});
  const exportFilters = state.adminWorkspace.exportFilters ?? {};
  const roleUsers = state.roleManagement.users ?? [];
  const roleAuditLogsByUser = state.roleManagement.auditLogsByUser ?? {};
  const roleManagementLoadError = state.roleManagement.loadError;
  const authUserCount = roleUsers.length;
  const assignedRoleCount = roleUsers.filter((user) => Boolean(user.current_role)).length;
  const roleManagementStatusMessage = roleManagementLoadError
    ? `<p class="muted">Fehler beim Laden: ${escapeHtml(roleManagementLoadError)}</p>`
    : authUserCount === 0
      ? '<p class="muted">Keine Auth-User gefunden.</p>'
      : assignedRoleCount === 0
        ? '<p class="muted">Auth-User gefunden, aber keine Rollen zugewiesen.</p>'
        : `<p class="muted">Auth-User: <code>${authUserCount}</code> • Mit Rolle: <code>${assignedRoleCount}</code></p>`;
  const buildSection = (jobType) => {
    const jobs = state.monitor.deadLetters[jobType] ?? [];
    const filter = state.monitor.filters[jobType] ?? { errorCode: 'all', search: '' };
    const selected = new Set(state.monitor.selectedJobs[jobType] ?? []);
    const selectedDetail = state.monitor.selectedDetailByType[jobType];
    const filtered = jobs.filter((job) => {
      if (filter.errorCode !== 'all' && (job.last_error_code ?? 'unknown') !== filter.errorCode) return false;
      if (filter.search && !`${job.id} ${job.last_error_code ?? ''} ${job.last_error ?? job.error_message ?? ''}`.toLowerCase().includes(filter.search.toLowerCase())) return false;
      return true;
    });
    const codes = [...new Set(jobs.map((job) => job.last_error_code ?? 'unknown'))];
    return `
      <section class="card">
        <h3>${jobType === 'publish' ? 'Publish' : 'Generation'} Dead-Letter</h3>
        <div class="grid">
          <label>Error-Code
            <select data-ops-filter-type="${jobType}" data-ops-filter-key="errorCode">
              <option value="all">all</option>
              ${codes.map((code) => `<option value="${code}" ${filter.errorCode === code ? 'selected' : ''}>${code}</option>`).join('')}
            </select>
          </label>
          <label>Suche
            <input data-ops-filter-type="${jobType}" data-ops-filter-key="search" value="${escapeHtml(filter.search ?? '')}" placeholder="job-id oder fehlermeldung" />
          </label>
        </div>
        <div class="inline-actions">
          <button data-batch-action="${jobType}" data-batch-mode="retry">Auswahl retry</button>
          <button data-batch-action="${jobType}" data-batch-mode="discard">Auswahl verwerfen</button>
          <span class="muted">${selected.size} ausgewählt</span>
        </div>
        ${filtered.map((job) => `
          <div class="list-item">
            <label><input type="checkbox" data-select-job-type="${jobType}" data-select-job-id="${job.id}" ${selected.has(job.id) ? 'checked' : ''}/> <code>${job.id}</code></label>
            <div class="muted">${job.last_error_code ?? 'unknown'} • Attempts ${job.attempts ?? 0}/${job.max_attempts ?? '—'} • Dead-Letter seit ${job.dead_lettered_at ? new Date(job.dead_lettered_at).toLocaleString() : '—'}</div>
            <div class="inline-actions">
              <button data-detail-type="${jobType}" data-detail-id="${job.id}">Details</button>
              <button data-retry-type="${jobType}" data-retry-id="${job.id}">Retry</button>
              <button data-discard-type="${jobType}" data-discard-id="${job.id}">Verwerfen</button>
            </div>
            <ul>${estimateAttemptHistory(job)}</ul>
          </div>
        `).join('') || '<p class="muted">Keine Jobs für diese Filter.</p>'}
        <h4>Detailansicht ${jobType}</h4>
        <pre>${selectedDetail ? JSON.stringify(selectedDetail, null, 2) : 'Noch kein Job gewählt.'}</pre>
      </section>
    `;
  };
  return `
    <section class="card">
      <h2>Ops Monitoring</h2>
      <div class="inline-actions">
        <button id="refresh-monitor">Dashboard aktualisieren</button>
        <button id="recover-stuck-jobs">recover-stuck-jobs</button>
      </div>
      ${alerts.map((alert) => `<div class="banner"><h4>${alert.label}</h4><p>${alert.action}</p></div>`).join('') || '<p class="muted">Keine priorisierten Alarmindikatoren im aktuellen Fenster.</p>'}
      <p class="muted">Publish Success-Rate (24h): <code>${Number(monitor.success_rate ?? 0) * 100}%</code> • Ø Publish-Latenz: <code>${monitor.publish_latency_seconds ?? 0}s</code></p>
      <p class="muted">Status Publish: <code>${JSON.stringify(monitor.publish_status_distribution ?? {})}</code> • Generation: <code>${JSON.stringify(monitor.generation_status_distribution ?? {})}</code></p>
    </section>
    <div class="ops-layout">
      ${buildSection('publish')}
      ${buildSection('generation')}
    </div>
    <section class="card">
      <h3>CSV Export</h3>
      <p class="muted">Filter gelten für jeden Export-Button (falls vom Backend unterstützt).</p>
      <div class="grid">
        <label>Von (UTC)
          <input id="export-filter-from" type="datetime-local" value="${escapeHtml(exportFilters.from ?? '')}" />
        </label>
        <label>Bis (UTC)
          <input id="export-filter-to" type="datetime-local" value="${escapeHtml(exportFilters.to ?? '')}" />
        </label>
        <label>Book ID (UUID)
          <input id="export-filter-book-id" value="${escapeHtml(exportFilters.bookId ?? '')}" placeholder="optional" />
        </label>
        <label>Campaign ID (UUID)
          <input id="export-filter-campaign-id" value="${escapeHtml(exportFilters.campaignId ?? '')}" placeholder="optional" />
        </label>
        <label>Plattform
          <input id="export-filter-platform" value="${escapeHtml(exportFilters.platform ?? '')}" placeholder="linkedin/x/instagram ..." />
        </label>
      </div>
      <div class="inline-actions">
        <button data-export-fn="export_posts_csv">Posts CSV</button>
        <button data-export-fn="export_publish_jobs_csv">Publish Jobs CSV</button>
        <button data-export-fn="export_kpi_metrics_csv">KPI Metrics CSV</button>
        <button data-export-fn="export_campaigns_csv">Campaigns CSV</button>
        <button data-export-fn="export_book_seed_overview_csv">Book Seed Overview CSV</button>
      </div>
    </section>
    <section class="card">
      <h3>Benutzer & Rollen</h3>
      <p class="muted">Nur Owner dürfen Rollen ändern. Änderungen werden über <code>set-user-role</code> ausgeführt.</p>
      ${state.currentRole !== 'owner' ? '<p class="muted">Keine Berechtigung zur Rollenverwaltung.</p>' : ''}
      ${state.currentRole === 'owner' ? roleManagementStatusMessage : ''}
      ${state.currentRole === 'owner' ? roleUsers.map((user) => {
        const label = [user.display_name, user.email].filter(Boolean).join(' • ') || user.user_id;
        const roleLabel = user.current_role ? `<code>${user.current_role}</code>` : '<span class="muted">keine Rolle</span>';
        const selectedRole = user.current_role ?? '';
        return `
        <div class="list-item">
          <div><strong>${escapeHtml(label)}</strong></div>
          <div class="muted">user_id: <code>${user.user_id}</code></div>
          <div class="inline-actions">
            <span>Aktuelle Rolle: ${roleLabel}</span>
            <select data-user-role-select="${user.user_id}">
              <option value="" ${selectedRole === '' ? 'selected' : ''}>keine Rolle</option>
              ${['owner', 'editor', 'viewer'].map((roleOption) => `<option value="${roleOption}" ${selectedRole === roleOption ? 'selected' : ''}>${roleOption}</option>`).join('')}
            </select>
            <button data-user-role-save="${user.user_id}">Rolle setzen</button>
          </div>
          <div>
            <strong>Änderungsverlauf</strong>
            ${(roleAuditLogsByUser[user.user_id] ?? []).map((entry) => `<div class="muted">${new Date(entry.created_at).toLocaleString()} • ${entry.action} • actor: ${entry.actor_user_id ?? 'system'} • details: ${JSON.stringify(entry.details ?? {})}</div>`).join('') || '<p class="muted">Keine Änderungen protokolliert.</p>'}
          </div>
        </div>
      `;
      }).join('') || '' : ''}
    </section>
    <section class="card">
      <h3>Admin Settings (Owner only)</h3>
      ${state.currentRole !== 'owner' ? '<p class="muted">Nur Owner dürfen Limits, Feature-Toggles und Maintenance Mode verwalten.</p>' : `
        <div class="grid">
          <label>max_posts_per_day
            <input id="admin-limit-max-posts-per-day" type="number" min="1" value="${Number(limits.max_posts_per_day ?? 50)}" />
          </label>
          <label>max_publish_jobs_batch
            <input id="admin-limit-max-publish-batch" type="number" min="1" value="${Number(limits.max_publish_jobs_batch ?? 100)}" />
          </label>
          <label>max_generation_jobs_batch
            <input id="admin-limit-max-generation-batch" type="number" min="1" value="${Number(limits.max_generation_jobs_batch ?? 100)}" />
          </label>
        </div>
        <h4>Feature-Toggles</h4>
        <div class="inline-actions">
          <label><input id="admin-toggle-csv-exports" type="checkbox" ${toggles.enable_csv_exports !== false ? 'checked' : ''} /> CSV Exporte</label>
          <label><input id="admin-toggle-dead-letter-ops" type="checkbox" ${toggles.enable_dead_letter_ops !== false ? 'checked' : ''} /> Dead-Letter Ops</label>
          <label><input id="admin-toggle-direct-publish" type="checkbox" ${toggles.enable_direct_publish !== false ? 'checked' : ''} /> Direct Publish</label>
          <label><input id="admin-toggle-seed-overview-export" type="checkbox" ${toggles.enable_seed_overview_export !== false ? 'checked' : ''} /> Seed Overview Export</label>
        </div>
        <h4>Maintenance Mode</h4>
        <div class="grid">
          <label><input id="admin-maintenance-mode" type="checkbox" ${adminSettings.maintenance_mode ? 'checked' : ''} /> Wartungsmodus aktiv</label>
          <label>Maintenance Message
            <input id="admin-maintenance-message" value="${escapeHtml(adminSettings.maintenance_message ?? '')}" placeholder="Hinweistext für Nutzer" />
          </label>
        </div>
        <div class="inline-actions">
          <button id="admin-save-limits-toggles">Limits & Toggles speichern</button>
          <button id="admin-save-maintenance">Maintenance Mode speichern</button>
        </div>
      `}
    </section>
    <p id="ops-status" class="muted"></p>
  `;
};

const DashboardView = () => {
  const widgets = state.kpi.widgets ?? {};
  const topCtr = widgets.top_ctr_posts ?? [];
  const platformComparison = widgets.platform_comparison ?? [];
  const underperformers = widgets.underperformers ?? [];
  const timeseries = state.kpi.timeseries ?? [];
  const variantRows = state.kpi.variantPerformance ?? [];
  const variantByPost = variantRows.reduce((acc, row) => {
    acc[row.post_id] = acc[row.post_id] ?? { title: row.title, platform: row.platform, rows: [] };
    acc[row.post_id].rows.push(row);
    return acc;
  }, {});

  return `
    <section class="card">
      <h2>KPI Dashboard</h2>
      <div class="inline-actions"><button id="refresh-dashboard">Dashboard aktualisieren</button></div>
      <p class="muted">Aggregationen aus <code>dashboard_widgets</code> + ergänzende Zeitreihe aus <code>post_metrics</code>.</p>
      <div class="kpi-grid">
        <div class="kpi-tile">
          <strong>Top CTR</strong>
          ${topCtr.map((item, index) => `<div class="muted">#${index + 1} ${escapeHtml(item.title ?? item.post_id)} • ${pct(item.ctr)}</div>`).join('') || '<div class="muted">Keine Daten.</div>'}
        </div>
        <div class="kpi-tile">
          <strong>Plattformvergleich</strong>
          ${platformComparison.map((item) => `<div class="muted">${item.platform}: CTR ${pct(item.ctr)} • Engagement ${pct(item.engagement_rate)}</div>`).join('') || '<div class="muted">Keine Daten.</div>'}
        </div>
        <div class="kpi-tile">
          <strong>Underperformer</strong>
          ${underperformers.map((item) => `<div class="muted">${escapeHtml(item.title ?? item.post_id)} • CTR ${pct(item.ctr)}</div>`).join('') || '<div class="muted">Keine Daten.</div>'}
        </div>
      </div>
    </section>

    <section class="card">
      <h3>Zeitreihe (CTR / Engagement je Tag)</h3>
      ${timeseries.map((point) => `<div class="muted">${point.metric_date}: CTR ${pct(point.ctr)} • Engagement ${pct(point.engagement_rate)} • Impressions ${point.impressions}</div>`).join('') || '<p class="muted">Keine Zeitreihenwerte im Zeitraum.</p>'}
    </section>

    <section class="card">
      <h3>Variantenleistung je Post (A/B/C)</h3>
      ${Object.entries(variantByPost).map(([postId, postData]) => {
    const sorted = [...postData.rows].sort((a, b) => (
      metricValue(b.ctr) - metricValue(a.ctr)
      || metricValue(b.engagement_rate) - metricValue(a.engagement_rate)
      || metricValue(b.impressions) - metricValue(a.impressions)
    ));
    const winner = sorted[0];
    const second = sorted[1];
    return `
          <div class="list-item">
            <strong>${escapeHtml(postData.title ?? postId)}</strong> <span class="muted">(${postData.platform})</span>
            <div class="muted">Gewinner: <span class="winner">${winner?.variant_name ?? '—'}</span> — ${getVariantWinnerReason(winner, second)}</div>
            <ul>
              ${sorted.map((row) => `<li>${row.variant_name}: CTR ${pct(row.ctr)} • Engagement ${pct(row.engagement_rate)} • Impressions ${row.impressions}${row === winner ? ' ✅' : ''}</li>`).join('')}
            </ul>
          </div>
        `;
  }).join('') || '<p class="muted">Keine Variantenmetriken vorhanden.</p>'}
    </section>

    <p id="dashboard-status" class="muted">${state.kpi.loadingError ? `Fehler: ${escapeHtml(state.kpi.loadingError)}` : ''}</p>
  `;
};


const loadPdfWorkspace = async (session) => {
  const { data: books, error: booksError } = await supabase
    .from('books')
    .select('id, title, description, status, updated_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (booksError) throw new Error(`Bücher konnten nicht geladen werden: ${booksError.message}`);

  const { data: documents, error: docsError } = await supabase
    .from('book_documents')
    .select('id, book_id, file_name, source_uri, parse_status, parse_error, created_at, updated_at, parsed_at, document_metadata')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (docsError) throw new Error(`Dokumente konnten nicht geladen werden: ${docsError.message}`);

  const { data: insights, error: insightsError } = await supabase
    .from('book_insights')
    .select('id, book_id, document_id, content, summary_short, summary_long, key_topics, quote_candidates, content_seeds, updated_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (insightsError) throw new Error(`Insights konnten nicht geladen werden: ${insightsError.message}`);

  state.pdfWorkspace.books = books ?? [];
  state.pdfWorkspace.documents = documents ?? [];
  state.pdfWorkspace.insights = insights ?? [];
  if (!state.pdfWorkspace.selectedBookId || !state.pdfWorkspace.books.some((book) => book.id === state.pdfWorkspace.selectedBookId)) {
    state.pdfWorkspace.selectedBookId = state.pdfWorkspace.books[0]?.id ?? null;
  }
  state.pdfWorkspace.userId = session?.user?.id ?? null;
};

const loadBufferState = async () => {
  const { data: accounts } = await supabase.from('buffer_accounts').select('id, access_status, last_sync_error, status').eq('status', 'active').order('updated_at', { ascending: false }).limit(1);
  state.buffer.accounts = accounts ?? [];
  state.buffer.accountId = accounts?.[0]?.id ?? null;

  if (state.buffer.accountId) {
    const { data: profiles } = await supabase.from('buffer_profiles').select('id, service, profile_name').eq('buffer_account_id', state.buffer.accountId).eq('status', 'active');
    state.buffer.profiles = profiles ?? [];
  } else {
    state.buffer.profiles = [];
  }

  const { data: platformAccounts } = await supabase.from('platform_accounts').select('id, platform, account_name, auth_status, is_active').eq('is_active', true);
  state.buffer.platformAccounts = platformAccounts ?? [];

  const { data: latestJob } = await supabase.from('publish_jobs').select('provider, buffer_update_id, attempts, last_error').order('created_at', { ascending: false }).limit(1);
  state.buffer.debug = latestJob?.[0] ?? null;

  const { data: recentProfileErrors } = await supabase
    .from('publish_jobs')
    .select('buffer_profile_id, last_error_code, last_error, updated_at')
    .not('last_error_code', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(100);

  const accountStatus = state.buffer.accounts[0]?.access_status ?? null;
  const profileConnectionFlow = {};
  const profileErrorActions = {};

  ['linkedin', 'instagram', 'x', 'facebook', 'threads', 'tiktok', 'youtube', 'pinterest'].forEach((platform) => {
    const mappedProfileId = state.buffer.profileMap[platform] ?? null;
    const latestError = (recentProfileErrors ?? []).find((entry) => (
      mappedProfileId && entry.buffer_profile_id === mappedProfileId
    ));
    profileConnectionFlow[platform] = getProfileConnectionStatus({
      accountStatus,
      latestErrorCode: latestError?.last_error_code ?? state.buffer.accounts[0]?.last_sync_error ?? '',
      hasMapping: Boolean(mappedProfileId),
    });
    if (latestError?.last_error_code || latestError?.last_error) {
      profileErrorActions[platform] = mapProviderErrorToAction(latestError.last_error_code, latestError.last_error);
    }
  });

  state.buffer.profileConnectionFlow = profileConnectionFlow;
  state.buffer.profileErrorActions = profileErrorActions;

  const { data: monitoring } = await supabase.rpc('job_monitoring_dashboard', { p_window_hours: 24 });
  const { count: stuckPublishCount } = await supabase
    .from('publish_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running')
    .lt('lease_expires_at', new Date().toISOString());
  const { count: stuckGenerationCount } = await supabase
    .from('generation_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running')
    .lt('lease_expires_at', new Date().toISOString());
  state.monitor.summary = {
    ...(monitoring ?? {}),
    stuck_jobs: {
      publish: stuckPublishCount ?? 0,
      generation: stuckGenerationCount ?? 0,
    },
  };

  const { data: publishDead } = await supabase
    .from('publish_jobs')
    .select('id, last_error_code, last_error, dead_lettered_at, updated_at, attempts, max_attempts, next_attempt_at, created_at')
    .eq('status', 'dead_letter')
    .order('updated_at', { ascending: false })
    .limit(20);
  state.monitor.deadLetters.publish = publishDead ?? [];

  const { data: generationDead } = await supabase
    .from('generation_jobs')
    .select('id, last_error_code, error_message, dead_lettered_at, updated_at, attempts, max_attempts, next_attempt_at, created_at')
    .eq('status', 'dead_letter')
    .order('updated_at', { ascending: false })
    .limit(20);
  state.monitor.deadLetters.generation = generationDead ?? [];
};

const loadCampaignWorkspace = async () => {
  const { data: campaigns, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, name, summary, campaign_type, objective, period_starts_at, period_ends_at, platform_mix, cadence, cta_goal, updated_at')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (campaignError) throw campaignError;

  const { data: seriesRules } = await supabase
    .from('campaign_series_rules')
    .select('id, campaign_id, allowed_weekdays, allowed_times, topic_rotation, platform_frequencies, timezone, status')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(200);

  const { data: evergreenRules } = await supabase
    .from('evergreen_repost_rules')
    .select('id, campaign_id, platform, min_spacing_days, variant_rotation, min_kpi_metric, min_kpi_threshold, status')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(400);

  const { data: calendarEvents } = await supabase
    .from('calendar_events')
    .select('id, post_id, campaign_id, platform, starts_at, ends_at, timezone, conflict_flags, status')
    .is('deleted_at', null)
    .order('starts_at', { ascending: true })
    .limit(500);

  const { data: bulkGenerationJobs } = await supabase
    .from('bulk_generation_jobs')
    .select('id, campaign_id, requested_count, generation_brief, options, status, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(100);

  const { data: bulkSchedulerJobs } = await supabase
    .from('bulk_scheduler_jobs')
    .select('id, campaign_id, platform, window_start, window_end, timezone, max_per_day, options, status, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(100);

  state.campaignWorkspace.campaigns = campaigns ?? [];
  state.campaignWorkspace.seriesRules = seriesRules ?? [];
  state.campaignWorkspace.evergreenRules = evergreenRules ?? [];
  state.campaignWorkspace.calendarEvents = calendarEvents ?? [];
  state.campaignWorkspace.bulkGenerationJobs = bulkGenerationJobs ?? [];
  state.campaignWorkspace.bulkSchedulerJobs = bulkSchedulerJobs ?? [];
  const existingCampaignIds = new Set((campaigns ?? []).map((campaign) => campaign.id));
  if (state.campaignWorkspace.selectedCampaignId !== 'all' && !existingCampaignIds.has(state.campaignWorkspace.selectedCampaignId)) {
    state.campaignWorkspace.selectedCampaignId = 'all';
  }
};

const loadKpiDashboard = async () => {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  state.kpi.range = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  state.kpi.loadingError = null;

  const { data: widgets, error: widgetError } = await supabase.rpc('dashboard_widgets', {
    p_from: state.kpi.range.from,
    p_to: state.kpi.range.to,
    p_book_id: null,
    p_campaign_id: null,
    p_platform: null,
  });
  if (widgetError) throw widgetError;
  state.kpi.widgets = widgets ?? {};

  const { data: metricRows, error: metricError } = await supabase
    .from('post_metrics')
    .select('metric_date, impressions, clicks, interactions')
    .gte('metric_date', state.kpi.range.from)
    .lte('metric_date', state.kpi.range.to)
    .order('metric_date', { ascending: true });
  if (metricError) throw metricError;

  const timeseriesMap = (metricRows ?? []).reduce((acc, row) => {
    const key = row.metric_date;
    const current = acc[key] ?? { metric_date: key, impressions: 0, clicks: 0, interactions: 0 };
    current.impressions += Number(row.impressions ?? 0);
    current.clicks += Number(row.clicks ?? 0);
    current.interactions += Number(row.interactions ?? 0);
    acc[key] = current;
    return acc;
  }, {});
  state.kpi.timeseries = Object.values(timeseriesMap).map((row) => ({
    ...row,
    ctr: row.impressions > 0 ? (row.clicks * 100) / row.impressions : 0,
    engagement_rate: row.impressions > 0 ? (row.interactions * 100) / row.impressions : 0,
  }));

  const { data: variantRows, error: variantError } = await supabase
    .from('dashboard_post_kpis')
    .select('post_id, title, platform, post_variant_id, ctr, engagement_rate, impressions');
  if (variantError) throw variantError;
  const variantIds = [...new Set((variantRows ?? []).map((row) => row.post_variant_id).filter(Boolean))];
  const { data: variants } = variantIds.length
    ? await supabase.from('post_variants').select('id, metadata').in('id', variantIds)
    : { data: [] };
  const variantNameById = (variants ?? []).reduce((acc, variant) => {
    acc[variant.id] = variant.metadata?.name ?? 'A';
    return acc;
  }, {});
  state.kpi.variantPerformance = (variantRows ?? []).map((row) => ({
    ...row,
    variant_name: variantNameById[row.post_variant_id] ?? 'A',
  }));
};

const loadMediaAssets = async (postId = null) => {
  let query = supabase
    .from('media_assets')
    .select('id, post_id, asset_type, provider, storage_path, mime_type, metadata, status, created_at')
    .is('deleted_at', null)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })
    .limit(100);
  if (isUuid(postId)) query = query.eq('post_id', postId);
  const { data, error } = await query;
  if (error) throw error;
  state.mediaLibrary.assets = data ?? [];
};

const loadCurrentRole = async (session) => {
  if (!session?.user?.id) {
    state.currentRole = null;
    return;
  }
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', session.user.id).maybeSingle();
  if (error) {
    throw new Error(`Rolle konnte nicht geladen werden: ${error.message}`);
  }
  state.currentRole = data?.role ?? null;
};

const loadRoleManagement = async () => {
  state.roleManagement.users = [];
  state.roleManagement.auditLogsByUser = {};
  state.roleManagement.loadError = null;

  if (state.currentRole !== 'owner') return;

  const { data: roleUsersData, error: roleUsersError } = await supabase.functions.invoke('list-users-for-role-admin', {
    body: {},
  });
  if (roleUsersError) {
    const rawMessage = String(roleUsersError.message ?? roleUsersError);
    state.roleManagement.loadError = `Benutzerrollen konnten nicht geladen werden (${rawMessage})`;
    return;
  }
  if (roleUsersData?.ok === false) {
    state.roleManagement.loadError = `Benutzerrollen konnten nicht geladen werden (${roleUsersData.error ?? 'operation_failed'})`;
    return;
  }

  const { data: auditLogs, error: logError } = await supabase
    .from('audit_logs')
    .select('id, actor_user_id, action, entity, entity_id, details, created_at')
    .eq('entity', 'user_roles')
    .in('action', ['role_assigned', 'role_changed', 'role_revoked'])
    .order('created_at', { ascending: false })
    .limit(500);
  if (logError) {
    state.roleManagement.loadError = `Änderungsverlauf konnte nicht geladen werden (${logError.message})`;
  }

  state.roleManagement.users = (roleUsersData?.users ?? []).map((entry) => ({
    user_id: entry.user_id,
    email: entry.email ?? null,
    display_name: entry.display_name ?? null,
    current_role: entry.current_role,
    updated_at: entry.updated_at,
    created_at: entry.created_at,
  }));
  state.roleManagement.auditLogsByUser = (auditLogs ?? []).reduce((acc, entry) => {
    const key = entry.entity_id;
    if (!key) return acc;
    acc[key] = acc[key] ?? [];
    acc[key].push(entry);
    return acc;
  }, {});
};

const loadAdminWorkspace = async () => {
  const { data, error } = await supabase
    .from('admin_settings')
    .select('id, global_limits, feature_toggles, maintenance_mode, maintenance_message, updated_at, updated_by')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`Admin Settings konnten nicht geladen werden: ${error.message}`);
  state.adminWorkspace.settings = data ?? null;
};

const invokeSetUserRole = async (userId, role) => {
  const { data, error } = await supabase.functions.invoke('set-user-role', {
    body: { user_id: userId, role },
  });

  if (error) {
    const rawMessage = String(error.message ?? error);
    if (rawMessage.includes('403') || rawMessage.includes('forbidden')) {
      throw new Error('Policy-Verletzung: Nur Owner dürfen Rollen ändern.');
    }
    if (rawMessage.includes('401') || rawMessage.includes('unauthorized')) {
      throw new Error('Nicht autorisiert: Bitte erneut einloggen.');
    }
    throw new Error(`set-user-role fehlgeschlagen: ${rawMessage}`);
  }

  if (data?.ok === false) {
    if (data.error === 'forbidden') throw new Error('Policy-Verletzung: Nur Owner dürfen Rollen ändern.');
    if (data.error === 'invalid_request') throw new Error('Ungültige Rollenänderung: user_id oder Rolle fehlt/ist ungültig.');
    throw new Error(`set-user-role Fehler: ${data.error ?? 'operation_failed'}`);
  }
};

const SessionGuard = async (viewName) => {
  const session = await getSession();
  if (!session && viewName !== 'login' && viewName !== 'auth-callback') {
    navigate('login', { next: buildViewUrl(viewName) });
    return null;
  }
  return session;
};

const bindLoginEvents = () => {
  const magicForm = document.getElementById('magic-link-form');
  const passwordForm = document.getElementById('password-form');
  const signUpButton = document.getElementById('password-signup');
  const status = document.getElementById('login-status');
  const existingError = readAuthError();
  if (existingError && status) status.textContent = existingError;

  magicForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('send-link');
    const email = magicForm.email.value.trim();
    if (!email) return;
    button.disabled = true;
    if (status) status.textContent = 'Sende Magic-Link…';
    try {
      await signInWithMagicLink(email);
      if (status) status.textContent = 'Magic-Link gesendet. Prüfe dein Postfach (inkl. Spam).';
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      setTimeout(() => {
        button.disabled = false;
      }, 1500);
    }
  });

  passwordForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('password-login');
    const email = passwordForm.email.value.trim();
    const password = passwordForm.password.value;
    if (!email || !password) return;
    button.disabled = true;
    if (status) status.textContent = 'Login läuft…';
    try {
      await signInWithPassword(email, password);
      await writeAuditLog('login', { source: 'frontend', method: 'password' });
      navigate('studio');
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  signUpButton?.addEventListener('click', async () => {
    const email = passwordForm.email.value.trim();
    const password = passwordForm.password.value;
    if (!email || !password) {
      if (status) status.textContent = 'Bitte E-Mail und Passwort eingeben.';
      return;
    }
    signUpButton.disabled = true;
    try {
      await signUpWithPassword(email, password);
      if (status) status.textContent = 'Account angelegt. Je nach Supabase-Einstellung bitte E-Mail bestätigen.';
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      signUpButton.disabled = false;
    }
  });
};

const bindStudioEvents = () => {
  const setStatus = (msg) => {
    const el = document.getElementById('studio-status');
    if (el) el.textContent = msg;
  };
  const post = getPost();
  const refreshStudio = async (statusMessage = null) => {
    const session = await getSession();
    await loadPdfWorkspace(session);
    await loadBufferState();
    await loadCampaignWorkspace();
    await loadMediaAssets(state.selectedId);
    renderLayout(StudioView());
    if (statusMessage) {
      const el = document.getElementById('studio-status');
      if (el) el.textContent = statusMessage;
    }
    bindStudioEvents();
  };
  const syncGenerationConfigFromUi = () => {
    post.generationConfig = {
      platform: document.getElementById('ai-platform')?.value ?? post.platform ?? 'linkedin',
      language: document.getElementById('ai-language')?.value ?? post.language ?? 'de',
      variants: Math.min(3, Math.max(1, Number(document.getElementById('ai-variant-count')?.value ?? 2))),
      stylePreset: document.getElementById('ai-style-preset')?.value ?? 'professional',
    };
  };
  const getSelectedVariant = () => post.variants.find((v) => v.is_selected) ?? post.variants[0];
  const persistWorkflowState = async (postId, nextStatus, extra = {}) => {
    if (!isUuid(postId)) return;
    const session = await getSession();
    if (!session?.user?.id) throw new Error('Nicht eingeloggt: Status-Update nicht möglich.');
    const payload = {
      status: nextStatus,
      workflow_status: nextStatus,
      updated_by: session.user.id,
      ...extra,
    };
    const { error } = await supabase.from('posts').update(payload).eq('id', postId);
    if (error) throw error;
  };

  document.getElementById('book-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = document.getElementById('book-title')?.value?.trim();
    const description = document.getElementById('book-description')?.value?.trim() ?? '';
    if (!title) return setStatus('Bitte einen Buchtitel angeben.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Buchanlage nicht möglich.');
      const { data, error } = await supabase
        .from('books')
        .insert({
          title,
          description,
          status: 'active',
          created_by: session.user.id,
          updated_by: session.user.id,
        })
        .select('id')
        .single();
      if (error) throw error;
      state.pdfWorkspace.selectedBookId = data.id;
      await refreshStudio(`Buch "${title}" wurde angelegt.`);
    } catch (error) {
      setStatus(`Buchanlage fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('book-select')?.addEventListener('change', (event) => {
    state.pdfWorkspace.selectedBookId = event.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.getElementById('pdf-upload-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const selectedBookId = state.pdfWorkspace.selectedBookId;
    const fileInput = document.getElementById('pdf-file');
    const file = fileInput?.files?.[0];
    if (!selectedBookId) return setStatus('Bitte zuerst ein Buch auswählen.');
    if (!file) return setStatus('Bitte eine PDF-Datei auswählen.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Upload nicht möglich.');
      const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const objectPath = `${selectedBookId}/${Date.now()}-${sanitizedFileName}`;
      const { error: uploadError } = await supabase.storage.from('book-pdfs').upload(objectPath, file, { contentType: file.type || 'application/pdf' });
      if (uploadError) throw new Error(`Storage-Upload fehlgeschlagen (${uploadError.message}).`);
      const { error: docError } = await supabase.from('book_documents').insert({
        book_id: selectedBookId,
        source_type: 'upload',
        source_uri: `book-pdfs/${objectPath}`,
        file_name: file.name,
        mime_type: file.type || 'application/pdf',
        parse_status: 'uploaded',
        created_by: session.user.id,
        updated_by: session.user.id,
      });
      if (docError) throw docError;
      await refreshStudio(`PDF "${file.name}" wurde hochgeladen.`);
    } catch (error) {
      setStatus(`PDF-Upload fehlgeschlagen: ${error.message}`);
    }
  });

  document.querySelectorAll('[data-start-analysis]').forEach((button) => {
    button.addEventListener('click', async () => {
      const documentId = button.dataset.startAnalysis;
      if (!documentId) return;
      const { data, error } = await supabase.functions.invoke('start-pdf-analysis', {
        body: { document_id: documentId, force: false },
      });
      if (error || data?.ok === false) return setStatus(`Analyse starten fehlgeschlagen: ${error?.message ?? data?.error ?? 'unknown_error'}`);
      await refreshStudio('Analyse wurde gestartet.');
    });
  });

  document.querySelectorAll('[data-reanalyze]').forEach((button) => {
    button.addEventListener('click', async () => {
      const documentId = button.dataset.reanalyze;
      if (!documentId) return;
      const { data, error } = await supabase.functions.invoke('start-pdf-analysis', {
        body: { document_id: documentId, force: true },
      });
      if (error || data?.ok === false) return setStatus(`Neu analysieren fehlgeschlagen: ${error?.message ?? data?.error ?? 'unknown_error'}`);
      await refreshStudio('Neu-Analyse wurde gestartet.');
    });
  });

  document.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('change', (e) => {
      state.filters[e.target.dataset.filter] = e.target.value;
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.getElementById('campaign-workspace-select')?.addEventListener('change', (event) => {
    state.campaignWorkspace.selectedCampaignId = event.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.getElementById('campaign-create')?.addEventListener('click', async () => {
    const name = document.getElementById('campaign-create-name')?.value?.trim();
    if (!name) return setStatus('Bitte einen Kampagnennamen eingeben.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Kampagne kann nicht erstellt werden.');
      const { data, error } = await supabase.from('campaigns').insert({
        name,
        campaign_type: 'one_off',
        platform_mix: [],
        cadence: { interval: 1, unit: 'week', weekdays: [1, 3, 5], times: ['09:00'] },
        created_by: session.user.id,
        updated_by: session.user.id,
      }).select('id').single();
      if (error) throw error;
      state.campaignWorkspace.selectedCampaignId = data.id;
      await refreshStudio('Kampagne angelegt.');
    } catch (error) {
      setStatus(`Kampagnenanlage fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('campaign-save')?.addEventListener('click', async () => {
    const campaignId = state.campaignWorkspace.selectedCampaignId;
    if (!isUuid(campaignId)) return setStatus('Bitte eine konkrete Kampagne auswählen.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Speichern nicht möglich.');
      const platformMix = Array.from(document.querySelectorAll('[data-platform-mix]:checked')).map((el) => el.dataset.platformMix);
      const cadencePayload = {
        interval: Number(document.getElementById('campaign-cadence-interval')?.value ?? 1),
        unit: document.getElementById('campaign-cadence-unit')?.value ?? 'week',
        weekdays: parseNumericArray(document.getElementById('campaign-cadence-weekdays')?.value, []),
        times: parseStringArray(document.getElementById('campaign-cadence-times')?.value, []),
      };
      const payload = {
        name: document.getElementById('campaign-name')?.value?.trim() ?? 'Unbenannt',
        summary: document.getElementById('campaign-summary')?.value?.trim() ?? null,
        campaign_type: document.getElementById('campaign-type')?.value ?? 'one_off',
        objective: document.getElementById('campaign-objective')?.value?.trim() ?? null,
        cta_goal: document.getElementById('campaign-cta-goal')?.value?.trim() ?? null,
        period_starts_at: document.getElementById('campaign-period-start')?.value || null,
        period_ends_at: document.getElementById('campaign-period-end')?.value || null,
        platform_mix: platformMix,
        cadence: cadencePayload,
        updated_by: session.user.id,
      };
      const { error } = await supabase.from('campaigns').update(payload).eq('id', campaignId);
      if (error) throw error;
      await refreshStudio('Kampagne inkl. Cadence/Plattformmix gespeichert.');
    } catch (error) {
      setStatus(`Kampagne speichern fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('series-save')?.addEventListener('click', async () => {
    const campaignId = state.campaignWorkspace.selectedCampaignId;
    if (!isUuid(campaignId)) return setStatus('Bitte eine konkrete Kampagne auswählen.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Series-Regel kann nicht gespeichert werden.');
      const payload = {
        campaign_id: campaignId,
        allowed_weekdays: parseNumericArray(document.getElementById('series-weekdays')?.value, [1, 2, 3, 4, 5]),
        allowed_times: parseStringArray(document.getElementById('series-times')?.value, ['09:00']),
        timezone: document.getElementById('series-timezone')?.value?.trim() ?? 'UTC',
        topic_rotation: [],
        platform_frequencies: {},
        updated_by: session.user.id,
        created_by: session.user.id,
      };
      const { error } = await supabase.from('campaign_series_rules').upsert(payload, { onConflict: 'campaign_id' });
      if (error) throw error;
      await refreshStudio('Series-Regel gespeichert.');
    } catch (error) {
      setStatus(`Series-Regel speichern fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('calendar-view')?.addEventListener('change', (event) => {
    state.campaignWorkspace.calendarView = event.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });
  document.getElementById('calendar-anchor-date')?.addEventListener('change', (event) => {
    state.campaignWorkspace.calendarAnchorDate = event.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });
  document.getElementById('calendar-filter-platform')?.addEventListener('change', (event) => {
    state.campaignWorkspace.calendarFilters.platform = event.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });
  document.getElementById('calendar-filter-status')?.addEventListener('change', (event) => {
    state.campaignWorkspace.calendarFilters.status = event.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.querySelectorAll('[data-reschedule-event]').forEach((button) => {
    button.addEventListener('click', async () => {
      const eventId = button.dataset.rescheduleEvent;
      const startsAt = document.querySelector(`[data-reschedule-at="${eventId}"]`)?.value;
      const postId = button.dataset.reschedulePost;
      const platform = button.dataset.reschedulePlatform;
      const campaignId = button.dataset.rescheduleCampaign || null;
      if (!startsAt || !isUuid(postId)) return setStatus('Ungültige Terminverschiebung.');
      const { data, error } = await supabase.rpc('schedule_calendar_event', {
        p_post_id: postId,
        p_campaign_id: isUuid(campaignId) ? campaignId : null,
        p_platform: platform,
        p_starts_at: new Date(startsAt).toISOString(),
      });
      if (error) return setStatus(`Terminverschiebung fehlgeschlagen: ${error.message}`);
      if (Array.isArray(data?.conflict_flags) && data.conflict_flags.length) {
        setStatus(`Termin verschoben mit Konflikten: ${data.conflict_flags.join(', ')}`);
      } else {
        setStatus('Termin erfolgreich verschoben.');
      }
      await refreshStudio();
    });
  });

  document.getElementById('bulk-generation-create')?.addEventListener('click', async () => {
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Bulk-Generator kann nicht erstellt werden.');
      const options = JSON.parse(document.getElementById('bulk-generation-options')?.value || '{}');
      const { error } = await supabase.from('bulk_generation_jobs').insert({
        campaign_id: isUuid(state.campaignWorkspace.selectedCampaignId) ? state.campaignWorkspace.selectedCampaignId : null,
        requested_count: Number(document.getElementById('bulk-generation-count')?.value ?? 10),
        generation_brief: document.getElementById('bulk-generation-brief')?.value?.trim() ?? null,
        options,
        status: 'queued',
        created_by: session.user.id,
        updated_by: session.user.id,
      });
      if (error) throw error;
      await refreshStudio('Bulk-Generator-Job angelegt.');
    } catch (error) {
      setStatus(`Bulk-Generator fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('bulk-scheduler-create')?.addEventListener('click', async () => {
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Bulk-Scheduler kann nicht erstellt werden.');
      const options = JSON.parse(document.getElementById('bulk-scheduler-options')?.value || '{}');
      const { error } = await supabase.from('bulk_scheduler_jobs').insert({
        campaign_id: isUuid(state.campaignWorkspace.selectedCampaignId) ? state.campaignWorkspace.selectedCampaignId : null,
        platform: document.getElementById('bulk-scheduler-platform')?.value?.trim() || null,
        window_start: new Date(document.getElementById('bulk-scheduler-start')?.value).toISOString(),
        window_end: new Date(document.getElementById('bulk-scheduler-end')?.value).toISOString(),
        timezone: document.getElementById('bulk-scheduler-timezone')?.value?.trim() || 'UTC',
        max_per_day: Number(document.getElementById('bulk-scheduler-max-per-day')?.value ?? 3),
        options,
        status: 'queued',
        created_by: session.user.id,
        updated_by: session.user.id,
      });
      if (error) throw error;
      await refreshStudio('Bulk-Scheduler-Job angelegt.');
    } catch (error) {
      setStatus(`Bulk-Scheduler fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('evergreen-save')?.addEventListener('click', async () => {
    const campaignId = state.campaignWorkspace.selectedCampaignId;
    if (!isUuid(campaignId)) return setStatus('Bitte zuerst eine Kampagne für Evergreen-Regeln wählen.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Evergreen-Regel kann nicht gespeichert werden.');
      const payload = {
        campaign_id: campaignId,
        platform: document.getElementById('evergreen-platform')?.value?.trim() ?? 'linkedin',
        min_spacing_days: Number(document.getElementById('evergreen-spacing')?.value ?? 14),
        variant_rotation: document.getElementById('evergreen-rotation')?.value ?? 'round_robin',
        min_kpi_metric: document.getElementById('evergreen-kpi-metric')?.value?.trim() || null,
        min_kpi_threshold: document.getElementById('evergreen-kpi-threshold')?.value ? Number(document.getElementById('evergreen-kpi-threshold').value) : null,
        status: 'active',
        created_by: session.user.id,
        updated_by: session.user.id,
      };
      const { error } = await supabase.from('evergreen_repost_rules').upsert(payload, { onConflict: 'campaign_id,platform' });
      if (error) throw error;
      await refreshStudio('Evergreen-Regel gespeichert.');
    } catch (error) {
      setStatus(`Evergreen-Regel speichern fehlgeschlagen: ${error.message}`);
    }
  });

  document.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', async () => {
      state.selectedId = el.dataset.open;
      await loadMediaAssets(state.selectedId);
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.querySelectorAll('[data-archive]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!hasRolePermission('archive')) return setStatus('Nur owner darf archivieren.');
      const postToArchive = state.posts.find((item) => item.id === button.dataset.archive);
      if (!postToArchive) return setStatus('Post wurde nicht gefunden.');
      if (postToArchive.status === 'archived') return setStatus('Post ist bereits archiviert.');
      postToArchive.status = 'archived';
      state.selectedId = postToArchive.id;
      setStatus(`Post "${postToArchive.title}" archiviert.`);
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!hasRolePermission('delete')) return setStatus('Nur owner darf löschen.');
      if (state.posts.length <= 1) return setStatus('Mindestens ein Post muss bestehen bleiben.');
      const postId = button.dataset.delete;
      const postToDelete = state.posts.find((item) => item.id === postId);
      if (!postToDelete) return setStatus('Post wurde nicht gefunden.');
      const confirmed = window.confirm(`Post "${postToDelete.title}" wirklich endgültig löschen?`);
      if (!confirmed) return;
      try {
        if (isUuid(postId)) {
          const { error } = await supabase.from('posts').delete().eq('id', postId);
          if (error) throw error;
        } else {
          state.posts = state.posts.filter((item) => item.id !== postId);
          state.selectedId = getFallbackSelectedId(postId);
        }
        await loadPostsFromDb();
        setStatus(`Post "${postToDelete.title}" gelöscht.`);
        renderLayout(StudioView());
        bindStudioEvents();
      } catch (error) {
        setStatus(`DB-Fehler beim Löschen: ${error.message}`);
      }
    });
  });

  document.getElementById('create-post')?.addEventListener('click', async () => {
    const newPost = {
      title: 'Neuer Post',
      section: 'Content Studio',
      book: 'Unassigned',
      campaign: 'Drafts',
      platform: 'linkedin',
      language: 'de',
      tags: [],
      status: 'draft',
      cta: '',
      hook: '',
      link: '',
      utm: '',
      utmManualOverride: false,
      utmProfileId: null,
      hasImage: false,
      variants: [{ name: 'A', text: '', is_selected: true }],
      hashtags: [],
    };
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Post kann nicht gespeichert werden.');
      const userId = session.user.id;
      const { data: createdPost, error: postError } = await supabase
        .from('posts')
        .insert({
          title: newPost.title,
          body: '',
          status: newPost.status,
          platform: newPost.platform,
          language: newPost.language,
          destination_url: '',
          utm_url: '',
          utm_manual_override: false,
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .single();
      if (postError) throw postError;
      const { data: createdVariant, error: variantError } = await supabase
        .from('post_variants')
        .insert({
          post_id: createdPost.id,
          content: '',
          status: 'draft',
          hook_text: '',
          cta_text: '',
          hashtag_set: [],
          metadata: { name: 'A' },
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .single();
      if (variantError) throw variantError;
      const { error: selectVariantError } = await supabase
        .from('posts')
        .update({ selected_variant_id: createdVariant.id, updated_by: userId })
        .eq('id', createdPost.id);
      if (selectVariantError) throw selectVariantError;
      state.selectedId = createdPost.id;
      await loadPostsFromDb();
      setStatus('Neuer Post in der Datenbank angelegt.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`DB-Fehler beim Erstellen: ${error.message}`);
    }
  });

  document.querySelectorAll('[data-variant]').forEach((button) => {
    button.addEventListener('click', () => {
      const idx = Number(button.dataset.variant);
      post.variants.forEach((v, i) => {
        v.is_selected = i === idx;
      });
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.getElementById('add-variant')?.addEventListener('click', () => {
    if (!hasRolePermission('edit')) return setStatus('Keine Berechtigung für manuelle Variantenanlage.');
    post.variants.push({ name: String.fromCharCode(65 + post.variants.length), text: '', is_selected: false });
    renderLayout(StudioView());
    bindStudioEvents();
  });

  ['ai-platform', 'ai-language', 'ai-variant-count', 'ai-style-preset'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      syncGenerationConfigFromUi();
      setStatus(`KI-Parameter aktualisiert (${post.generationConfig.platform}/${post.generationConfig.language}/${post.generationConfig.variants}/${post.generationConfig.stylePreset}).`);
    });
  });

  document.getElementById('generate-text')?.addEventListener('click', async () => {
    syncGenerationConfigFromUi();
    if (!isUuid(post.bookId)) return setStatus('Text generieren benötigt einen gespeicherten Post mit book_id.');
    const payload = {
      book_id: post.bookId,
      campaign_id: isUuid(post.campaignId) ? post.campaignId : undefined,
      seed_ids: isUuid(post.seedId) ? [post.seedId] : undefined,
      platforms: [post.generationConfig.platform],
      languages: [post.generationConfig.language],
      variants_per_platform: post.generationConfig.variants,
      batch_size: 1,
      use_cache: false,
    };
    const { data, error } = await supabase.functions.invoke('generate-post-text', { body: payload });
    if (error || data?.ok === false) return setStatus(`Textgenerierung fehlgeschlagen: ${error?.message ?? data?.error ?? 'unknown_error'}`);
    await loadPostsFromDb();
    setStatus(`Text generiert: ${data?.created_posts ?? 0} Post(s), ${data?.created_variants ?? 0} Variante(n). Stilpreset: ${post.generationConfig.stylePreset}.`);
    renderLayout(StudioView());
    bindStudioEvents();
  });

  const runHashtagGeneration = async () => {
    syncGenerationConfigFromUi();
    if (!isUuid(post.id)) return setStatus('Hashtag-Generierung nur für gespeicherte Posts verfügbar.');
    const selectedVariant = getSelectedVariant();
    if (!isUuid(selectedVariant?.id)) return setStatus('Bitte zuerst Variante speichern.');
    const maxTags = (PLATFORM_LIMITS[post.generationConfig.platform] || PLATFORM_LIMITS.linkedin).hashtags;
    const { data, error } = await supabase.functions.invoke('generate-hashtags', {
      body: { post_id: post.id, language: post.generationConfig.language, max_tags: maxTags },
    });
    if (error || data?.ok === false) return setStatus(`Hashtag-Generierung fehlgeschlagen: ${error?.message ?? data?.error ?? 'unknown_error'}`);
    const tags = String(data?.hashtags ?? '').split(/\s+/).map((tag) => tag.trim()).filter(Boolean).slice(0, maxTags);
    const session = await getSession();
    if (session?.user?.id) {
      await supabase
        .from('post_variants')
        .update({ hashtag_set: tags, updated_by: session.user.id })
        .eq('id', selectedVariant.id);
    }
    post.hashtags = tags;
    selectedVariant.hashtags = tags;
    setStatus(`Hashtags generiert (${tags.length}) und in post_variants übernommen.`);
    renderLayout(StudioView());
    bindStudioEvents();
  };
  document.getElementById('generate-hashtags')?.addEventListener('click', runHashtagGeneration);

  document.getElementById('save-editor')?.addEventListener('click', async () => {
    if (!hasRolePermission('edit')) return setStatus('Keine Bearbeitungsrechte.');
    const selectedVariant = post.variants.find((v) => v.is_selected) ?? post.variants[0];
    selectedVariant.text = document.getElementById('variant-text').value;
    post.cta = document.getElementById('cta-input').value;
    post.hook = document.getElementById('hook-input').value;
    post.link = document.getElementById('link-input').value;
    post.utm = document.getElementById('utm-input').value;
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Speichern nicht möglich.');
      const userId = session.user.id;
      let postId = post.id;
      const selectedVariantPayload = post.variants.find((variant) => variant.is_selected);
      if (!isUuid(postId)) {
        const { data: createdPost, error: createPostError } = await supabase
          .from('posts')
          .insert({
            title: post.title ?? 'Neuer Post',
            body: selectedVariant?.text ?? '',
            status: post.status ?? 'draft',
            platform: post.platform ?? 'linkedin',
            language: post.language ?? 'de',
            destination_url: post.link ?? '',
            utm_url: post.utm ?? '',
            utm_manual_override: Boolean((post.utm ?? '').trim()),
            created_by: userId,
            updated_by: userId,
          })
          .select('id')
          .single();
        if (createPostError) throw createPostError;
        postId = createdPost.id;
      }
      const normalizedVariants = post.variants.map((variant, index) => ({
        id: isUuid(variant.id) ? variant.id : undefined,
        post_id: postId,
        content: variant.text ?? '',
        status: 'draft',
        hook_text: variant.is_selected ? post.hook : null,
        cta_text: variant.is_selected ? post.cta : null,
        hashtag_set: variant.is_selected ? (post.hashtags ?? []) : [],
        image_asset_id: variant.imageAssetId ?? null,
        metadata: {
          ...(variant.metadata ?? {}),
          name: variant.name ?? String.fromCharCode(65 + index),
          style_preset: post.generationConfig?.stylePreset ?? 'professional',
        },
        created_by: userId,
        updated_by: userId,
      }));

      const { data: upsertedVariants, error: upsertError } = await supabase
        .from('post_variants')
        .upsert(normalizedVariants, { onConflict: 'id' })
        .select('id, metadata');
      if (upsertError) throw upsertError;

      const selectedVariantId = upsertedVariants?.find((variant) => variant.metadata?.name === (selectedVariantPayload?.name ?? 'A'))?.id ?? null;
      const { error: postError } = await supabase
        .from('posts')
        .update({
          body: selectedVariant.text ?? '',
          destination_url: post.link ?? '',
          utm_url: post.utm ?? '',
          utm_manual_override: Boolean((post.utm ?? '').trim()),
          status: post.status,
          selected_variant_id: selectedVariantId,
          updated_by: userId,
        })
        .eq('id', postId);
      if (postError) throw postError;

      state.selectedId = postId;
      await loadPostsFromDb();
      setStatus('Editorinhalt in der Datenbank gespeichert.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`DB-Fehler beim Speichern: ${error.message}`);
    }
  });

  document.getElementById('pick-winner')?.addEventListener('click', () => {
    if (!hasRolePermission('select_winner')) return setStatus('Nur editor/owner darf Gewinner markieren.');
    const selectedVariant = post.variants.find((v) => v.is_selected);
    if (!selectedVariant) return setStatus('Bitte erst eine Variante auswählen.');
    post.variants = post.variants.map((v) => ({ ...v, is_selected: v.name === selectedVariant.name }));
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.querySelectorAll('[data-transition]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = button.dataset.transition;
      if (!canTransition(post.status, target)) {
        return setStatus(`Ungültiger Statuswechsel: ${post.status} → ${target}`);
      }
      if (target === 'approved' && !hasRolePermission('approve')) {
        return setStatus('Nur owner darf freigeben.');
      }
      if (target === 'approved') {
        const checks = getPreApprovalChecks(post);
        if (!Object.values(checks).slice(0, 5).every(Boolean)) {
          return setStatus('Freigabe blockiert: Pflichtchecks nicht erfüllt.');
        }
      }
      if (target === 'scheduled' && post.status !== 'approved') {
        return setStatus('Nur approved darf geplant werden.');
      }
      if (['scheduled', 'publishing', 'posted'].includes(target) && !hasRolePermission('publish')) {
        return setStatus('Scheduling/Publishing nur für owner erlaubt.');
      }
      try {
        const extra = target === 'approved'
          ? { approval_status: 'approved', approved_at: new Date().toISOString() }
          : (target === 'draft' ? { approval_status: 'pending', approved_at: null } : {});
        await persistWorkflowState(post.id, target, extra);
        post.status = target;
        await loadPostsFromDb();
        await loadMediaAssets(state.selectedId);
        setStatus(`Status gewechselt zu ${target}.`);
        renderLayout(StudioView());
        bindStudioEvents();
      } catch (error) {
        setStatus(`Statuswechsel fehlgeschlagen: ${error.message}`);
      }
    });
  });

  document.getElementById('review-approve')?.addEventListener('click', async () => {
    if (!hasRolePermission('approve')) return setStatus('Nur owner darf freigeben.');
    const checks = getPreApprovalChecks(post);
    if (!Object.values(checks).slice(0, 5).every(Boolean)) return setStatus('Freigabe blockiert: Pflichtchecks nicht erfüllt.');
    try {
      await persistWorkflowState(post.id, 'approved', { approval_status: 'approved', approved_at: new Date().toISOString() });
      await loadPostsFromDb();
      await loadMediaAssets(state.selectedId);
      setStatus('Review-Aktion ausgeführt: Approve.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`Approve fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('review-back-to-draft')?.addEventListener('click', async () => {
    if (!hasRolePermission('submit_review')) return setStatus('Keine Rechte für Review-Rückgabe.');
    try {
      await persistWorkflowState(post.id, 'draft', { approval_status: 'pending', approved_at: null });
      await loadPostsFromDb();
      await loadMediaAssets(state.selectedId);
      setStatus('Review-Aktion ausgeführt: Zurück zu Draft.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`Zurück zu Draft fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('review-duplicate')?.addEventListener('click', async () => {
    const selectedVariant = getSelectedVariant();
    if (!isUuid(post.id) || !isUuid(selectedVariant?.id)) return setStatus('Duplizieren benötigt gespeicherten Post + Variante.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Duplizieren nicht möglich.');
      const userId = session.user.id;
      const { data: duplicatedPost, error: postError } = await supabase
        .from('posts')
        .insert({
          title: `${post.title} (Kopie)`,
          body: selectedVariant.text ?? '',
          status: 'draft',
          workflow_status: 'draft',
          platform: post.platform,
          language: post.language,
          campaign_id: post.campaignId ?? null,
          destination_url: post.link ?? '',
          utm_url: post.utm ?? '',
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .single();
      if (postError) throw postError;
      const { data: duplicatedVariant, error: variantError } = await supabase
        .from('post_variants')
        .insert({
          post_id: duplicatedPost.id,
          content: selectedVariant.text ?? '',
          status: 'draft',
          hook_text: post.hook ?? '',
          cta_text: post.cta ?? '',
          hashtag_set: post.hashtags ?? [],
          image_asset_id: selectedVariant.imageAssetId ?? null,
          metadata: { ...(selectedVariant.metadata ?? {}), source_post_id: post.id, name: 'A' },
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .single();
      if (variantError) throw variantError;
      await supabase.from('posts').update({ selected_variant_id: duplicatedVariant.id, updated_by: userId }).eq('id', duplicatedPost.id);
      state.selectedId = duplicatedPost.id;
      await loadPostsFromDb();
      await loadMediaAssets(state.selectedId);
      setStatus('Review-Aktion ausgeführt: Duplizieren.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`Duplizieren fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('review-adopt-series')?.addEventListener('click', async () => {
    if (!isUuid(post.id)) return setStatus('In Serie übernehmen benötigt gespeicherten Post.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Serienübernahme nicht möglich.');
      const selectedVariant = getSelectedVariant();
      const { data, error } = await supabase.rpc('create_repurposed_post', {
        p_master_post_id: post.id,
        p_target_platform: post.platform,
        p_title: `${post.title} (Serie)`,
        p_body: `${selectedVariant?.text ?? post.title}\n\nSerie-Variante`,
        p_created_by: session.user.id,
      });
      if (error) throw error;
      if (data?.id) state.selectedId = data.id;
      await loadPostsFromDb();
      await loadMediaAssets(state.selectedId);
      setStatus('Review-Aktion ausgeführt: In Serie übernehmen.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`In Serie übernehmen fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('media-link-asset')?.addEventListener('click', async () => {
    const selectedVariant = getSelectedVariant();
    if (!isUuid(selectedVariant?.id)) return setStatus('Bitte Variante zuerst speichern.');
    const mediaAssetId = document.getElementById('media-asset-select')?.value || null;
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Verknüpfen nicht möglich.');
      await supabase.from('post_variants').update({ image_asset_id: mediaAssetId, updated_by: session.user.id }).eq('id', selectedVariant.id);
      await loadPostsFromDb();
      await loadMediaAssets(state.selectedId);
      setStatus('Asset mit post_variants.image_asset_id verknüpft.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`Asset-Verknüpfung fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('media-replace-asset')?.addEventListener('click', async () => {
    if (!isUuid(post.id)) return setStatus('Asset ersetzen benötigt gespeicherten Post.');
    const selectedVariant = getSelectedVariant();
    if (!isUuid(selectedVariant?.id)) return setStatus('Bitte Variante zuerst speichern.');
    const storagePath = document.getElementById('new-media-path')?.value?.trim();
    if (!storagePath) return setStatus('Bitte Storage Path für neues Asset angeben.');
    try {
      const session = await getSession();
      if (!session?.user?.id) return setStatus('Nicht eingeloggt: Asset-Anlage nicht möglich.');
      const width = Number(document.getElementById('new-media-width')?.value ?? 0);
      const height = Number(document.getElementById('new-media-height')?.value ?? 0);
      const mime = document.getElementById('new-media-mime')?.value?.trim() || 'image/png';
      const altText = document.getElementById('media-alt-text')?.value?.trim() || '';
      const { data: createdAsset, error: assetError } = await supabase
        .from('media_assets')
        .insert({
          post_id: post.id,
          owner_user_id: session.user.id,
          asset_type: 'image',
          storage_path: storagePath,
          mime_type: mime,
          metadata: { width, height, alt_text: altText },
          status: 'ready',
        })
        .select('id')
        .single();
      if (assetError) throw assetError;
      await supabase.from('post_variants').update({ image_asset_id: createdAsset.id, updated_by: session.user.id }).eq('id', selectedVariant.id);
      await loadPostsFromDb();
      await loadMediaAssets(state.selectedId);
      setStatus(`Neues Asset erstellt und verknüpft: ${createdAsset.id}`);
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`Asset ersetzen fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('media-save-alt')?.addEventListener('click', async () => {
    const mediaAssetId = document.getElementById('media-asset-select')?.value || getSelectedVariant()?.imageAssetId;
    if (!isUuid(mediaAssetId)) return setStatus('Kein gültiges Asset für Alt-Text ausgewählt.');
    try {
      const altText = document.getElementById('media-alt-text')?.value?.trim() ?? '';
      const existing = state.mediaLibrary.assets.find((asset) => asset.id === mediaAssetId);
      const metadata = { ...(existing?.metadata ?? {}), alt_text: altText };
      await supabase.from('media_assets').update({ metadata }).eq('id', mediaAssetId);
      await loadMediaAssets(state.selectedId);
      setStatus('Alt-Text am media_assets-Metadatum gespeichert.');
      renderLayout(StudioView());
      bindStudioEvents();
    } catch (error) {
      setStatus(`Alt-Text speichern fehlgeschlagen: ${error.message}`);
    }
  });

  document.getElementById('regen-hashtags')?.addEventListener('click', async () => {
    if (!hasRolePermission('regenerate_hashtags')) return setStatus('Keine Rechte zum Regenerieren.');
    await runHashtagGeneration();
  });

  document.getElementById('generate-image')?.addEventListener('click', async () => {
    syncGenerationConfigFromUi();
    if (!isUuid(post.id)) return setStatus('Bildgenerierung nur für gespeicherte Posts verfügbar.');
    const selectedVariant = getSelectedVariant();
    if (!isUuid(selectedVariant?.id)) return setStatus('Bitte zuerst Variante speichern.');
    const aspectRatio = IMAGE_ASPECT_RATIOS[post.generationConfig.platform] ?? '1:1';
    const prompt = `${post.generationConfig.stylePreset} ${post.title ?? 'Social visual'} ${selectedVariant.text ?? ''}`.trim();
    const { data, error } = await supabase.functions.invoke('generate-image', {
      body: { post_id: post.id, platform: post.generationConfig.platform, aspect_ratio: aspectRatio, prompt },
    });
    if (error || data?.ok === false) return setStatus(`Bildgenerierung fehlgeschlagen: ${error?.message ?? data?.error ?? 'unknown_error'}`);
    const session = await getSession();
    if (session?.user?.id && data?.media_asset_id) {
      await supabase
        .from('post_variants')
        .update({ image_asset_id: data.media_asset_id, updated_by: session.user.id })
        .eq('id', selectedVariant.id);
    }
    selectedVariant.hasImage = true;
    selectedVariant.imageAssetId = data?.media_asset_id ?? null;
    post.hasImage = true;
    setStatus(`Bildgenerierung gestartet. Media Asset: ${data?.media_asset_id ?? '—'}.`);
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.getElementById('quality-check')?.addEventListener('click', async () => {
    const selectedVariant = getSelectedVariant();
    if (!isUuid(selectedVariant?.id)) return setStatus('Qualitätscheck benötigt eine gespeicherte Variante.');
    const { data, error } = await supabase.functions.invoke('quality-score-post', {
      body: { post_variant_id: selectedVariant.id },
    });
    if (error || data?.ok === false) return setStatus(`Qualitätscheck fehlgeschlagen: ${error?.message ?? data?.error ?? 'unknown_error'}`);
    selectedVariant.metadata = {
      ...(selectedVariant.metadata ?? {}),
      quality_score: data?.score ?? 0,
      guardrail_ok: !(data?.violations?.length),
      violations: data?.violations ?? [],
    };
    setStatus(`Qualitätscheck abgeschlossen (Score: ${data?.score ?? 0}/100).`);
    renderLayout(StudioView());
    bindStudioEvents();
  });


  document.getElementById('buffer-connect')?.addEventListener('click', async () => {
    const { data, error } = await supabase.functions.invoke('connect-buffer-oauth', { body: {} });
    if (error || !data?.auth_url) return setStatus(`Buffer Connect fehlgeschlagen: ${error?.message ?? 'no_auth_url'}`);
    window.location.href = data.auth_url;
  });

  document.getElementById('buffer-reconnect')?.addEventListener('click', async () => {
    if (!state.buffer.accountId) return setStatus('Kein Buffer-Account für Reconnect vorhanden.');
    const { data, error } = await supabase.functions.invoke('connect-buffer-oauth', { body: { reconnect_buffer_account_id: state.buffer.accountId } });
    if (error || !data?.auth_url) return setStatus(`Reconnect fehlgeschlagen: ${error?.message ?? 'no_auth_url'}`);
    window.location.href = data.auth_url;
  });

  document.getElementById('buffer-sync')?.addEventListener('click', async () => {
    if (!state.buffer.accountId) return setStatus('Erst Buffer verbinden.');
    const { data, error } = await supabase.functions.invoke('sync-buffer-profiles', { body: { buffer_account_id: state.buffer.accountId } });
    if (error) return setStatus(`sync-buffer-profiles fehlgeschlagen: ${error.message}`);
    setStatus(`sync-buffer-profiles: ${data?.synced_count ?? 0} Profile.`);
    await loadBufferState();
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.getElementById('buffer-profile-map')?.addEventListener('change', (event) => {
    state.buffer.profileMap[post.platform] = event.target.value || null;
    setStatus(`Profil-Mapping für ${post.platform} gespeichert.`);
  });

  document.getElementById('publish-via')?.addEventListener('change', (event) => {
    state.buffer.publishVia = event.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });

  const publishViaProvider = async (scheduledAt = null) => {
    const publishVia = state.buffer.publishVia;
    const mappedProfileId = state.buffer.profileMap[post.platform];
    const mappedPlatformAccount = state.buffer.platformAccounts.find((account) => account.platform === post.platform);
    const validation = runPublishPrevalidations({
      post,
      publishVia,
      mappedProfileId,
      mappedPlatformAccount,
      scheduledAt,
    });
    if (!validation.ok) {
      return setStatus(`Vorabvalidierung fehlgeschlagen (${scheduledAt ? 'Scheduled' : 'Sofort'}): ${validation.errors.join(' | ')}`);
    }
    const { data, error } = await supabase.functions.invoke('publish-via-buffer', {
      body: {
        post_id: post.id,
        buffer_profile_id: mappedProfileId,
        platform_account_id: mappedPlatformAccount?.id ?? null,
        publish_via: publishVia,
        platform: post.platform,
        text: validation.selectedVariant?.text ?? post.title,
        media: validation.media,
        scheduled_at: scheduledAt,
      },
    });
    if (error || data?.ok === false) {
      const action = mapProviderErrorToAction(data?.error, error?.message ?? '');
      state.buffer.profileErrorActions[post.platform] = action;
      state.buffer.profileConnectionFlow[post.platform] = getProfileConnectionStatus({
        accountStatus: state.buffer.accounts[0]?.access_status ?? null,
        latestErrorCode: data?.error ?? error?.message ?? '',
        hasMapping: Boolean(mappedProfileId),
      });
      renderLayout(StudioView());
      bindStudioEvents();
      return setStatus(`publish-via-buffer Fehler: ${data?.error ?? error?.message ?? 'unknown_error'} → Aktion: ${action.action}. ${action.hint}`);
    }
    state.buffer.profileErrorActions[post.platform] = null;
    state.buffer.profileConnectionFlow[post.platform] = getProfileConnectionStatus({
      accountStatus: state.buffer.accounts[0]?.access_status ?? null,
      latestErrorCode: '',
      hasMapping: Boolean(mappedProfileId),
    });
    state.buffer.debug = {
      provider: publishVia,
      buffer_update_id: data?.buffer_update_id ?? null,
      attempts: 1,
      last_error: null,
    };
    setStatus(`publish-via-buffer gestartet via ${publishVia} (${scheduledAt ? 'geplant' : 'sofort'}).`);
    renderLayout(StudioView());
    bindStudioEvents();
  };

  document.getElementById('buffer-publish-now')?.addEventListener('click', async () => publishViaProvider(null));
  document.getElementById('buffer-publish-scheduled')?.addEventListener('click', async () => publishViaProvider(new Date(Date.now() + 15 * 60_000).toISOString()));

  document.getElementById('sort-hashtags')?.addEventListener('click', () => {
    const input = document.getElementById('hashtags-input').value;
    const tags = input.split(',').map((x) => x.trim()).filter(Boolean);
    const limit = (PLATFORM_LIMITS[post.platform] || PLATFORM_LIMITS.linkedin).hashtags;
    post.hashtags = tags.slice(0, limit);
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.getElementById('open-ops')?.addEventListener('click', () => navigate('ops'));
};

const bindOpsEvents = () => {
  const setStatus = (msg) => {
    const el = document.getElementById('ops-status');
    if (el) el.textContent = msg;
  };
  const refreshOps = async (message = null) => {
    await loadBufferState();
    await loadAdminWorkspace();
    await loadRoleManagement();
    renderLayout(OpsView());
    bindOpsEvents();
    if (message) setStatus(message);
  };
  const syncExportFiltersFromUi = () => {
    state.adminWorkspace.exportFilters = {
      from: document.getElementById('export-filter-from')?.value ?? '',
      to: document.getElementById('export-filter-to')?.value ?? '',
      bookId: document.getElementById('export-filter-book-id')?.value?.trim() ?? '',
      campaignId: document.getElementById('export-filter-campaign-id')?.value?.trim() ?? '',
      platform: document.getElementById('export-filter-platform')?.value?.trim() ?? '',
    };
  };
  const toIsoOrNull = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const toDateOrNull = (value) => {
    if (!value) return null;
    return value.slice(0, 10);
  };
  const triggerCsvDownload = (content, fileName) => {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  document.getElementById('refresh-monitor')?.addEventListener('click', async () => refreshOps('Monitoring-Dashboard aktualisiert.'));
  document.getElementById('recover-stuck-jobs')?.addEventListener('click', async () => {
    const { error } = await supabase.rpc('recover_stuck_jobs', { p_requeue_delay_seconds: 30 });
    if (error) return setStatus(`recover-stuck-jobs fehlgeschlagen: ${error.message}`);
    await refreshOps('recover-stuck-jobs ausgeführt.');
  });
  document.querySelectorAll('[data-ops-filter-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const jobType = input.dataset.opsFilterType;
      const key = input.dataset.opsFilterKey;
      state.monitor.filters[jobType][key] = input.value;
      renderLayout(OpsView());
      bindOpsEvents();
    });
  });
  document.querySelectorAll('[data-select-job-id]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const jobType = checkbox.dataset.selectJobType;
      const jobId = checkbox.dataset.selectJobId;
      const selected = new Set(state.monitor.selectedJobs[jobType] ?? []);
      if (checkbox.checked) selected.add(jobId); else selected.delete(jobId);
      state.monitor.selectedJobs[jobType] = [...selected];
      renderLayout(OpsView());
      bindOpsEvents();
    });
  });
  document.querySelectorAll('[data-detail-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobType = button.dataset.detailType;
      const jobId = button.dataset.detailId;
      const { data, error } = await supabase.rpc('job_detail_redacted', { p_job_type: jobType, p_job_id: jobId });
      if (error) return setStatus(`Detailabruf fehlgeschlagen: ${error.message}`);
      state.monitor.selectedDetailByType[jobType] = data;
      renderLayout(OpsView());
      bindOpsEvents();
    });
  });
  document.querySelectorAll('[data-retry-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobType = button.dataset.retryType;
      const jobId = button.dataset.retryId;
      const { data, error } = await supabase.rpc('retry_dead_letter_job', { p_job_type: jobType, p_job_id: jobId });
      if (error || !data) return setStatus(`Retry fehlgeschlagen: ${error?.message ?? 'not_allowed_or_not_dead_letter'}`);
      await refreshOps(`Dead-Letter Job ${jobId} wurde erneut in die Queue gestellt.`);
    });
  });
  document.querySelectorAll('[data-discard-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobType = button.dataset.discardType;
      const jobId = button.dataset.discardId;
      const { data, error } = await supabase.rpc('discard_dead_letter_job', { p_job_type: jobType, p_job_id: jobId });
      if (error || !data) return setStatus(`Verwerfen fehlgeschlagen: ${error?.message ?? 'not_allowed_or_not_dead_letter'}`);
      await refreshOps(`Dead-Letter Job ${jobId} wurde verworfen.`);
    });
  });
  document.querySelectorAll('[data-batch-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobType = button.dataset.batchAction;
      const mode = button.dataset.batchMode;
      const selected = state.monitor.selectedJobs[jobType] ?? [];
      if (!selected.length) return setStatus('Bitte mindestens einen Job auswählen.');
      let ok = 0;
      for (const jobId of selected) {
        const fn = mode === 'retry' ? 'retry_dead_letter_job' : 'discard_dead_letter_job';
        const { data } = await supabase.rpc(fn, { p_job_type: jobType, p_job_id: jobId });
        if (data) ok += 1;
      }
      state.monitor.selectedJobs[jobType] = [];
      await refreshOps(`${ok}/${selected.length} Jobs (${jobType}) erfolgreich: ${mode}.`);
    });
  });
  ['export-filter-from', 'export-filter-to', 'export-filter-book-id', 'export-filter-campaign-id', 'export-filter-platform'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', syncExportFiltersFromUi);
  });
  document.querySelectorAll('[data-export-fn]').forEach((button) => {
    button.addEventListener('click', async () => {
      syncExportFiltersFromUi();
      const exportFn = button.dataset.exportFn;
      const filters = state.adminWorkspace.exportFilters;
      const payload = {
        p_from: exportFn === 'export_kpi_metrics_csv' ? toDateOrNull(filters.from) : toIsoOrNull(filters.from),
        p_to: exportFn === 'export_kpi_metrics_csv' ? toDateOrNull(filters.to) : toIsoOrNull(filters.to),
        p_book_id: isUuid(filters.bookId) ? filters.bookId : null,
        p_campaign_id: isUuid(filters.campaignId) ? filters.campaignId : null,
        p_platform: filters.platform || null,
      };
      const { data, error } = await supabase.rpc(exportFn, payload);
      if (error) return setStatus(`${exportFn} fehlgeschlagen: ${error.message}`);
      triggerCsvDownload(data ?? '', `${exportFn}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);
      setStatus(`${exportFn} erfolgreich exportiert.`);
    });
  });
  document.querySelectorAll('[data-user-role-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = button.dataset.userRoleSave;
      const select = document.querySelector(`[data-user-role-select="${userId}"]`);
      const nextRole = select?.value;
      if (!userId || !nextRole) return setStatus('Ungültige Rollenänderung: user_id oder Rolle fehlt.');
      try {
        await invokeSetUserRole(userId, nextRole);
        await refreshOps(`Rolle für ${userId} auf "${nextRole}" aktualisiert.`);
      } catch (error) {
        setStatus(error.message);
      }
    });
  });
  document.getElementById('admin-save-limits-toggles')?.addEventListener('click', async () => {
    if (state.currentRole !== 'owner') return setStatus('Nur Owner dürfen Admin Settings ändern.');
    try {
      const current = state.adminWorkspace.settings ?? {};
      const payload = {
        global_limits: {
          ...(parseObject(current.global_limits, {})),
          max_posts_per_day: Number(document.getElementById('admin-limit-max-posts-per-day')?.value ?? 50),
          max_publish_jobs_batch: Number(document.getElementById('admin-limit-max-publish-batch')?.value ?? 100),
          max_generation_jobs_batch: Number(document.getElementById('admin-limit-max-generation-batch')?.value ?? 100),
        },
        feature_toggles: {
          ...(parseObject(current.feature_toggles, {})),
          enable_csv_exports: Boolean(document.getElementById('admin-toggle-csv-exports')?.checked),
          enable_dead_letter_ops: Boolean(document.getElementById('admin-toggle-dead-letter-ops')?.checked),
          enable_direct_publish: Boolean(document.getElementById('admin-toggle-direct-publish')?.checked),
          enable_seed_overview_export: Boolean(document.getElementById('admin-toggle-seed-overview-export')?.checked),
        },
      };
      const { error } = await supabase.from('admin_settings').update(payload).eq('id', 1);
      if (error) throw error;
      await refreshOps('Admin-Limits und Feature-Toggles gespeichert.');
    } catch (error) {
      setStatus(`Admin Settings speichern fehlgeschlagen: ${error.message}`);
    }
  });
  document.getElementById('admin-save-maintenance')?.addEventListener('click', async () => {
    if (state.currentRole !== 'owner') return setStatus('Nur Owner dürfen den Wartungsmodus ändern.');
    const enabled = Boolean(document.getElementById('admin-maintenance-mode')?.checked);
    const message = document.getElementById('admin-maintenance-message')?.value?.trim() || null;
    const { error } = await supabase.rpc('set_maintenance_mode', {
      p_enabled: enabled,
      p_message: message,
    });
    if (error) return setStatus(`set_maintenance_mode fehlgeschlagen: ${error.message}`);
    await refreshOps(`Maintenance Mode ${enabled ? 'aktiviert' : 'deaktiviert'}.`);
  });
};

const bindDashboardEvents = () => {
  const setStatus = (msg) => {
    const el = document.getElementById('dashboard-status');
    if (el) el.textContent = msg;
  };
  document.getElementById('refresh-dashboard')?.addEventListener('click', async () => {
    try {
      await loadKpiDashboard();
      renderLayout(DashboardView());
      bindDashboardEvents();
      setStatus('Dashboard aktualisiert.');
    } catch (error) {
      setStatus(`Dashboard-Aktualisierung fehlgeschlagen: ${error.message}`);
    }
  });
};

const bindEvents = (viewName, session) => {
  if (viewName === 'login') bindLoginEvents();
  if (viewName === 'health' && session) {
    document.getElementById('logout')?.addEventListener('click', async () => {
      await writeAuditLog('logout', { source: 'frontend' });
      await signOut();
      navigate('login');
    });
  }
  if (viewName === 'studio') bindStudioEvents();
  if (viewName === 'ops') bindOpsEvents();
  if (viewName === 'dashboard') bindDashboardEvents();
};

const handleAuthCallback = async () => {
  const errorMessage = readAuthError();
  if (errorMessage) {
    renderLayout(`<section class="card"><h2>Login fehlgeschlagen</h2><p>${errorMessage}</p><button id="back-login">Neuen Link anfordern</button></section>`);
    document.getElementById('back-login')?.addEventListener('click', () => navigate('login'));
    return;
  }

  try {
    await exchangeAuthCode();
    await writeAuditLog('login', { source: 'frontend', method: 'magic_link' });
    const target = getParam('next') || buildViewUrl('studio');
    window.location.replace(target);
  } catch (error) {
    renderLayout(`<section class="card"><h2>Login fehlgeschlagen</h2><p>${error.message}</p><button id="back-login">Zurück zum Login</button></section>`);
    document.getElementById('back-login')?.addEventListener('click', () => navigate('login'));
  }
};

const renderView = async (viewName) => {
  setActiveNav(viewName === 'auth-callback' ? 'login' : viewName);

  if (viewName === 'auth-callback') {
    renderLayout(AuthCallbackView());
    await handleAuthCallback();
    return;
  }

  if (viewName === 'login') {
    renderLayout(LoginView());
    bindEvents(viewName);
    return;
  }

  const session = await SessionGuard(viewName);
  if (!session) return;

  try {
    await loadCurrentRole(session);
  } catch (error) {
    renderLayout(`<section class="card"><h2>Rollenprüfung fehlgeschlagen</h2><p>${error.message}</p></section>`);
    return;
  }

  if (!state.currentRole) {
    renderLayout(AccessDeniedView(session));
    return;
  }

  if (viewName === 'studio') {
    await runInitialOnboardingSeed();
    try {
      await loadPostsFromDb();
    } catch (error) {
      logger.error('load_posts_failed', { message: error.message });
    }
    try {
      await loadPdfWorkspace(session);
    } catch (error) {
      logger.warn('load_pdf_workspace_failed', { message: error.message });
    }
    try {
      await loadCampaignWorkspace();
    } catch (error) {
      logger.warn('load_campaign_workspace_failed', { message: error.message });
    }
    await loadBufferState();
    try {
      await loadMediaAssets(state.selectedId);
    } catch (error) {
      logger.warn('load_media_assets_failed', { message: error.message });
    }
    renderLayout(StudioView());
    bindEvents(viewName, session);
    return;
  }

  if (viewName === 'ops') {
    await loadBufferState();
    try {
      await loadAdminWorkspace();
    } catch (error) {
      logger.warn('load_admin_workspace_failed', { message: error.message });
    }
    try {
      await loadRoleManagement();
    } catch (error) {
      logger.warn('load_role_management_failed', { message: error.message });
    }
    renderLayout(OpsView());
    bindEvents(viewName, session);
    return;
  }

  if (viewName === 'dashboard') {
    try {
      await loadKpiDashboard();
    } catch (error) {
      state.kpi.loadingError = error.message;
    }
    renderLayout(DashboardView());
    bindEvents(viewName, session);
    return;
  }

  renderLayout(HealthView(session));
  bindEvents(viewName, session);
};

const boot = async () => {
  const view = getCurrentView();
  if (hasAuthCode() && view !== 'auth-callback') {
    const next = getParam('next') || buildViewUrl('studio');
    navigate('auth-callback', { next });
    return;
  }
  await renderView(view);
};

window.addEventListener('popstate', boot);
navButtons.forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.view));
});

logger.info('frontend_shell_initialized', {
  appVersion: PUBLIC_CONFIG.APP_VERSION,
  supabaseUrl: PUBLIC_CONFIG.SUPABASE_URL,
});

boot();
