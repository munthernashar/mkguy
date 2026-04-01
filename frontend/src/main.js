import { PUBLIC_CONFIG } from './config.js';
import { logger } from './logger.js';
import { getCurrentView, getParam, getSession, signInWithMagicLink, signOut, exchangeAuthCode, writeAuditLog, buildViewUrl } from './auth.js';

const app = document.getElementById('app');
const navButtons = document.querySelectorAll('button[data-view]');

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

const LoginView = () => `
  <section class="card">
    <h2>Login</h2>
    <p class="muted">Melde dich mit einem Magic-Link an.</p>
    <form id="magic-link-form">
      <label for="email">E-Mail</label><br/>
      <input id="email" name="email" type="email" required placeholder="you@example.com" style="margin:0.5rem 0;padding:0.5rem;border-radius:6px;border:1px solid #475569;background:#0b1220;color:#e2e8f0;"/>
      <div>
        <button type="submit">Magic Link senden</button>
      </div>
      <p class="muted" id="login-status"></p>
    </form>
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

const SessionGuard = async (viewName) => {
  const session = await getSession();
  if (!session && viewName === 'health') {
    navigate('login', { next: buildViewUrl('health') });
    return null;
  }
  return session;
};

const bindEvents = (viewName, session) => {
  if (viewName === 'login') {
    const form = document.getElementById('magic-link-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.getElementById('login-status');
      const email = form.email.value.trim();
      if (!email) return;
      await signInWithMagicLink(email);
      if (status) status.textContent = 'Magic-Link gesendet. Prüfe dein Postfach.';
    });
  }

  if (viewName === 'health' && session) {
    const logoutButton = document.getElementById('logout');
    logoutButton?.addEventListener('click', async () => {
      await writeAuditLog('logout', { source: 'frontend' });
      await signOut();
      navigate('login');
    });
  }
};

const handleAuthCallback = async () => {
  try {
    await exchangeAuthCode();
    await writeAuditLog('login', { source: 'frontend' });
    const target = getParam('next') || buildViewUrl('health');
    window.location.replace(target);
  } catch (error) {
    renderLayout(`
      <section class="card">
        <h2>Login fehlgeschlagen</h2>
        <p>${error.message}</p>
        <button id="back-login">Zurück zum Login</button>
      </section>
    `);
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

  renderLayout(HealthView(session));
  bindEvents(viewName, session);
};

const boot = async () => {
  const view = getCurrentView();
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
