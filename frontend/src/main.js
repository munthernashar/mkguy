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
};

const CTA_HINTS = ['Starte jetzt', 'Kostenlos testen', 'Mehr erfahren', 'Termin buchen'];
const HOOK_HINTS = ['Provokante Frage', 'Statistik als Einstieg', 'Vorher/Nachher', 'Story in 1 Satz'];
const WORKFLOW_STATUSES = ['draft', 'review', 'approved', 'scheduled', 'publishing', 'posted', 'failed', 'archived'];

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
  role: 'editor',
  filters: { book: 'all', campaign: 'all', platform: 'all', language: 'all', tag: 'all' },
  selectedId: 'p1',

  buffer: {
    accountId: null,
    accounts: [],
    profiles: [],
    profileMap: {},
    debug: null,
    publishVia: 'buffer',
    platformAccounts: [],
  },
  monitor: {
    summary: null,
    deadLetters: { publish: [], generation: [] },
    selectedDetail: null,
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

const hasRolePermission = (action) => {
  if (state.role === 'owner') return true;
  const editorPermissions = ['edit', 'submit_review', 'regenerate_hashtags', 'select_winner'];
  return editorPermissions.includes(action);
};

const statusPill = (status) => `<span class="status-pill">${status}</span>`;

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

const StudioView = () => {
  const visiblePosts = state.posts.filter(applyFilters);
  const selected = getPost();
  const checks = getPreApprovalChecks(selected);
  const selectedVariant = selected.variants.find((v) => v.is_selected) ?? selected.variants[0];
  const text = selectedVariant?.text ?? '';
  const limits = PLATFORM_LIMITS[selected.platform] || PLATFORM_LIMITS.linkedin;
  const overLimit = text.length > limits.text;
  const monitor = state.monitor.summary ?? {};
  const publishStatus = monitor.publish_status_distribution ?? {};
  const generationStatus = monitor.generation_status_distribution ?? {};
  const topErrors = monitor.top_error_codes ?? [];
  const errorList = monitor.error_list ?? [];
  const publishDeadLetters = state.monitor.deadLetters.publish ?? [];
  const generationDeadLetters = state.monitor.deadLetters.generation ?? [];

  return `
    <section class="card">
      <h2>Frontend Arbeitsbereiche</h2>
      <div class="toolbar">
        <label>Rolle
          <select id="role-select">
            <option value="editor" ${state.role === 'editor' ? 'selected' : ''}>editor</option>
            <option value="owner" ${state.role === 'owner' ? 'selected' : ''}>owner</option>
          </select>
        </label>
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
        <h3>Content Studio</h3>
        <p class="muted">Editor mit Varianten A/B/C, Zeichenzähler, CTA-/Hook-Hinweisen und Freigabechecks.</p>
        ${visiblePosts.map((post) => `
          <div class="list-item">
            <strong>${post.title}</strong> ${statusPill(post.status)}
            <div class="muted">${post.section} • ${post.book} • ${post.campaign} • ${post.platform} • ${post.language}</div>
            <div class="inline-actions">
              <button data-open="${post.id}">Öffnen</button>
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
      <p class="hint">Hook-Hinweise: ${HOOK_HINTS.join(' • ')}</p>
      <p class="hint">CTA-Hinweise: ${CTA_HINTS.join(' • ')}</p>
      <div class="inline-actions">
        ${selected.variants.map((v, idx) => `<button data-variant="${idx}">${v.name}${v.is_selected ? ' ✅' : ''}</button>`).join('')}
        <button id="add-variant">Variante manuell anlegen</button>
      </div>
      <textarea id="variant-text" rows="5">${text}</textarea>
      <div class="inline-actions">
        <span class="${overLimit ? 'danger' : 'muted'}">${text.length}/${limits.text} Zeichen (${selected.platform})</span>
        <button id="save-editor">Text speichern</button>
        <button id="pick-winner">Gewinner markieren (is_selected)</button>
      </div>

      <h4>Workflow</h4>
      <div class="inline-actions">
        ${WORKFLOW_STATUSES.filter((s) => s !== selected.status).map((status) => `<button data-transition="${status}">${status}</button>`).join('')}
      </div>
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
      <p class="muted">Verbindungsstatus: ${state.buffer.accounts[0]?.access_status ?? 'nicht verbunden'}</p>
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
      <h4>Monitoring-Dashboard</h4>
      <div class="inline-actions">
        <button id="refresh-monitor">Dashboard aktualisieren</button>
        <button id="recover-stuck-jobs">recover-stuck-jobs</button>
      </div>
      <p class="muted">Publish Success-Rate (24h): <code>${Number(monitor.success_rate ?? 0) * 100}%</code> • Ø Publish-Latenz: <code>${monitor.publish_latency_seconds ?? 0}s</code></p>
      <p class="muted">Dead-Letter: Publish <code>${monitor.dead_letter?.publish ?? 0}</code> • Generation <code>${monitor.dead_letter?.generation ?? 0}</code></p>
      <h5>Statusverteilung</h5>
      <ul>
        <li>Publish: <code>${JSON.stringify(publishStatus)}</code></li>
        <li>Generation: <code>${JSON.stringify(generationStatus)}</code></li>
      </ul>
      <h5>Top-Fehlercodes</h5>
      <ul>
        ${topErrors.map((item) => `<li><code>${item.code}</code>: ${item.count}</li>`).join('') || '<li class="muted">Keine Fehler im Zeitfenster.</li>'}
      </ul>
      <h5>Fehlerliste</h5>
      <ul>
        ${errorList.map((item) => `<li><code>${item.last_error_code}</code> • ${item.status} • ${new Date(item.updated_at).toLocaleString()}<br/><span class="muted">${item.last_error ?? '—'}</span></li>`).join('') || '<li class="muted">Keine Fehler.</li>'}
      </ul>
      <h5>Dead-Letter Aktionen</h5>
      <p class="muted">Bei Token-/Verbindungsproblemen erst Verbindung erneuern (Buffer Connect/Reconnect + Sync) und erst dann manuell retry ausführen.</p>
      <div class="grid">
        <div>
          <strong>Publish Dead-Letter</strong>
          ${publishDeadLetters.map((job) => `
            <div class="list-item">
              <div><code>${job.id}</code> • ${job.last_error_code ?? 'unknown'}</div>
              <div class="inline-actions">
                <button data-detail-type="publish" data-detail-id="${job.id}">Details</button>
                <button data-retry-type="publish" data-retry-id="${job.id}">Retry</button>
                <button data-discard-type="publish" data-discard-id="${job.id}">Verwerfen</button>
              </div>
            </div>
          `).join('') || '<p class="muted">Keine Publish-Dead-Letter.</p>'}
        </div>
        <div>
          <strong>Generation Dead-Letter</strong>
          ${generationDeadLetters.map((job) => `
            <div class="list-item">
              <div><code>${job.id}</code> • ${job.last_error_code ?? 'unknown'}</div>
              <div class="inline-actions">
                <button data-detail-type="generation" data-detail-id="${job.id}">Details</button>
                <button data-retry-type="generation" data-retry-id="${job.id}">Retry</button>
                <button data-discard-type="generation" data-discard-id="${job.id}">Verwerfen</button>
              </div>
            </div>
          `).join('') || '<p class="muted">Keine Generation-Dead-Letter.</p>'}
        </div>
      </div>
      <h5>Job-Details (redacted)</h5>
      <pre>${state.monitor.selectedDetail ? JSON.stringify(state.monitor.selectedDetail, null, 2) : 'Noch kein Job gewählt.'}</pre>
      <p id="studio-status" class="muted"></p>
    </section>
  `;
};


const loadBufferState = async () => {
  const { data: accounts } = await supabase.from('buffer_accounts').select('id, access_status, access_status, status').eq('status', 'active').order('updated_at', { ascending: false }).limit(1);
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

  const { data: monitoring } = await supabase.rpc('job_monitoring_dashboard', { p_window_hours: 24 });
  state.monitor.summary = monitoring ?? null;

  const { data: publishDead } = await supabase
    .from('publish_jobs')
    .select('id, last_error_code, last_error, dead_lettered_at, updated_at')
    .eq('status', 'dead_letter')
    .order('updated_at', { ascending: false })
    .limit(20);
  state.monitor.deadLetters.publish = publishDead ?? [];

  const { data: generationDead } = await supabase
    .from('generation_jobs')
    .select('id, last_error_code, error_message, dead_lettered_at, updated_at')
    .eq('status', 'dead_letter')
    .order('updated_at', { ascending: false })
    .limit(20);
  state.monitor.deadLetters.generation = generationDead ?? [];
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

  document.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('change', (e) => {
      state.filters[e.target.dataset.filter] = e.target.value;
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.getElementById('role-select')?.addEventListener('change', (e) => {
    state.role = e.target.value;
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedId = el.dataset.open;
      renderLayout(StudioView());
      bindStudioEvents();
    });
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

  document.getElementById('save-editor')?.addEventListener('click', () => {
    if (!hasRolePermission('edit')) return setStatus('Keine Bearbeitungsrechte.');
    const selectedVariant = post.variants.find((v) => v.is_selected) ?? post.variants[0];
    selectedVariant.text = document.getElementById('variant-text').value;
    post.cta = document.getElementById('cta-input').value;
    post.hook = document.getElementById('hook-input').value;
    post.link = document.getElementById('link-input').value;
    post.utm = document.getElementById('utm-input').value;
    setStatus('Editorinhalt gespeichert.');
    renderLayout(StudioView());
    bindStudioEvents();
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
    button.addEventListener('click', () => {
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
      if (['scheduled', 'publishing', 'posted'].includes(target) && state.role !== 'owner') {
        return setStatus('Scheduling/Publishing nur für owner erlaubt.');
      }
      post.status = target;
      setStatus(`Status gewechselt zu ${target}.`);
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.getElementById('regen-hashtags')?.addEventListener('click', () => {
    if (!hasRolePermission('regenerate_hashtags')) return setStatus('Keine Rechte zum Regenerieren.');
    const base = ['#growth', '#socialmedia', '#contentstrategy', '#buildinpublic', '#marketing'];
    const limit = (PLATFORM_LIMITS[post.platform] || PLATFORM_LIMITS.linkedin).hashtags;
    post.hashtags = base.slice(0, limit);
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
    if (publishVia === 'buffer' && !mappedProfileId) return setStatus(`Kein Buffer-Profil für ${post.platform} gemappt.`);
    if (publishVia === 'direct' && !mappedPlatformAccount) return setStatus(`Kein Direct-Account für ${post.platform} verbunden.`);
    const selectedVariant = post.variants.find((v) => v.is_selected) ?? post.variants[0];
    const media = post.hasImage ? [{ url: 'https://picsum.photos/1080/1080.jpg', mime_type: 'image/jpeg', width: 1080, height: 1080 }] : [];
    const directCaps = DIRECT_CAPABILITY_MATRIX[post.platform] ?? { textOnly: false, media: false, scheduling: false };
    if (publishVia === 'direct' && media.length > 0 && !directCaps.media) return setStatus(`Nicht unterstützt: direct + Media für ${post.platform}.`);
    if (publishVia === 'direct' && scheduledAt && !directCaps.scheduling) return setStatus(`Nicht unterstützt: direct + Scheduling für ${post.platform}.`);
    const { data, error } = await supabase.functions.invoke('publish-via-buffer', {
      body: {
        post_id: post.id,
        buffer_profile_id: mappedProfileId,
        platform_account_id: mappedPlatformAccount?.id ?? null,
        publish_via: publishVia,
        platform: post.platform,
        text: selectedVariant?.text ?? post.title,
        media,
        scheduled_at: scheduledAt,
      },
    });
    if (error) return setStatus(`publish-via-buffer Fehler: ${error.message}`);
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

  document.getElementById('refresh-monitor')?.addEventListener('click', async () => {
    await loadBufferState();
    setStatus('Monitoring-Dashboard aktualisiert.');
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.getElementById('recover-stuck-jobs')?.addEventListener('click', async () => {
    const { error } = await supabase.rpc('recover_stuck_jobs', { p_requeue_delay_seconds: 30 });
    if (error) return setStatus(`recover-stuck-jobs fehlgeschlagen: ${error.message}`);
    await loadBufferState();
    setStatus('recover-stuck-jobs ausgeführt.');
    renderLayout(StudioView());
    bindStudioEvents();
  });

  document.querySelectorAll('[data-detail-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobType = button.dataset.detailType;
      const jobId = button.dataset.detailId;
      const { data, error } = await supabase.rpc('job_detail_redacted', { p_job_type: jobType, p_job_id: jobId });
      if (error) return setStatus(`Detailabruf fehlgeschlagen: ${error.message}`);
      state.monitor.selectedDetail = data;
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.querySelectorAll('[data-retry-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobType = button.dataset.retryType;
      const jobId = button.dataset.retryId;
      const { data, error } = await supabase.rpc('retry_dead_letter_job', { p_job_type: jobType, p_job_id: jobId });
      if (error || !data) return setStatus(`Retry fehlgeschlagen: ${error?.message ?? 'not_allowed_or_not_dead_letter'}`);
      await loadBufferState();
      setStatus(`Dead-Letter Job ${jobId} wurde erneut in die Queue gestellt.`);
      renderLayout(StudioView());
      bindStudioEvents();
    });
  });

  document.querySelectorAll('[data-discard-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const jobType = button.dataset.discardType;
      const jobId = button.dataset.discardId;
      const { data, error } = await supabase.rpc('discard_dead_letter_job', { p_job_type: jobType, p_job_id: jobId });
      if (error || !data) return setStatus(`Verwerfen fehlgeschlagen: ${error?.message ?? 'not_allowed_or_not_dead_letter'}`);
      await loadBufferState();
      setStatus(`Dead-Letter Job ${jobId} wurde verworfen.`);
      renderLayout(StudioView());
      bindStudioEvents();
    });
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

  if (viewName === 'studio') {
    await loadBufferState();
    renderLayout(StudioView());
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
