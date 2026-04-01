import { PUBLIC_CONFIG } from './config.js';
import { logger } from './logger.js';
import { getCurrentView, getParam, getSession, signInWithMagicLink, signOut, exchangeAuthCode, writeAuditLog, buildViewUrl, hasAuthCode, readAuthError, signInWithPassword, signUpWithPassword } from './auth.js';

const app = document.getElementById('app');
const navButtons = document.querySelectorAll('button[data-view]');
let booksHandlersBound = false;

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
    <p class="muted">Du kannst dich per Magic-Link oder Passwort anmelden.</p>

    <h3>Magic-Link</h3>
    <form id="magic-link-form">
      <label for="magic-email">E-Mail</label><br/>
      <input id="magic-email" name="email" type="email" required placeholder="you@example.com" style="margin:0.5rem 0;padding:0.5rem;border-radius:6px;border:1px solid #475569;background:#0b1220;color:#e2e8f0;"/>
      <div>
        <button id="send-link" type="submit">Magic Link senden</button>
      </div>
    </form>

    <h3>E-Mail + Passwort</h3>
    <form id="password-form">
      <label for="password-email">E-Mail</label><br/>
      <input id="password-email" name="email" type="email" required placeholder="you@example.com" style="margin:0.5rem 0;padding:0.5rem;border-radius:6px;border:1px solid #475569;background:#0b1220;color:#e2e8f0;"/><br/>
      <label for="password">Passwort</label><br/>
      <input id="password" name="password" type="password" required minlength="8" placeholder="••••••••" style="margin:0.5rem 0;padding:0.5rem;border-radius:6px;border:1px solid #475569;background:#0b1220;color:#e2e8f0;"/>
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

const SessionGuard = async (viewName) => {
  const session = await getSession();
  if (!session && viewName === 'health') {
    navigate('login', { next: buildViewUrl('health') });
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
  if (existingError && status) {
    status.textContent = existingError;
  }

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
      navigate('health');
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

const bindEvents = (viewName, session) => {
  if (viewName === 'login') {
    bindLoginEvents();
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
  const errorMessage = readAuthError();
  if (errorMessage) {
    renderLayout(`
      <section class="card">
        <h2>Login fehlgeschlagen</h2>
        <p>${errorMessage}</p>
        <button id="back-login">Neuen Link anfordern</button>
      </section>
    `);
    document.getElementById('back-login')?.addEventListener('click', () => navigate('login'));
    return;
  }

  try {
    await exchangeAuthCode();
    await writeAuditLog('login', { source: 'frontend', method: 'magic_link' });
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

  if (hasAuthCode() && view !== 'auth-callback') {
    const next = getParam('next') || buildViewUrl('health');
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
