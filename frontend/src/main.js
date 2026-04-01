import { PUBLIC_CONFIG } from './config.js';
import { logger } from './logger.js';

const app = document.getElementById('app');
const navButtons = document.querySelectorAll('button[data-view]');

const renderLogin = () => `
  <section class="card">
    <h2>Login placeholder</h2>
    <p class="muted">Auth UI and Supabase session flow will be added in the next iteration.</p>
    <ul>
      <li>Email/password form placeholder</li>
      <li>OAuth provider buttons placeholder</li>
      <li>Session state indicator placeholder</li>
    </ul>
  </section>
`;

const renderHealth = () => `
  <section class="card">
    <h2>Health view</h2>
    <p>Environment: <code>${PUBLIC_CONFIG.APP_ENV}</code></p>
    <p>Version: <code>${PUBLIC_CONFIG.APP_VERSION}</code></p>
    <p>Supabase URL: <code>${PUBLIC_CONFIG.SUPABASE_URL}</code></p>
    <p class="muted">This view will later call <code>/functions/v1/health</code> after auth bootstrapping is in place.</p>
  </section>
`;

const views = {
  login: renderLogin,
  health: renderHealth,
};

const render = (viewName) => {
  const template = views[viewName] || views.health;
  app.innerHTML = template();
  logger.info('view_rendered', {
    view: viewName,
    appEnv: PUBLIC_CONFIG.APP_ENV,
    supabaseAnonKey: PUBLIC_CONFIG.SUPABASE_ANON_KEY,
  });
};

navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    navButtons.forEach((entry) => entry.classList.remove('active'));
    button.classList.add('active');
    render(button.dataset.view);
  });
});

logger.info('frontend_shell_initialized', {
  appVersion: PUBLIC_CONFIG.APP_VERSION,
  supabaseUrl: PUBLIC_CONFIG.SUPABASE_URL,
  supabaseAnonKey: PUBLIC_CONFIG.SUPABASE_ANON_KEY,
});

render('health');
