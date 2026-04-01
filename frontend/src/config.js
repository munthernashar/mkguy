const isProdHost = window.location.hostname.endsWith('github.io');

const configModule = await (isProdHost
  ? import('../config/prod.js')
  : import('../config/dev.js'));

const { PUBLIC_CONFIG } = configModule;

const requiredKeys = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APP_ENV', 'APP_VERSION'];

for (const key of requiredKeys) {
  if (!PUBLIC_CONFIG[key]) {
    throw new Error(`Missing required public config key: ${key}`);
  }
}

export { PUBLIC_CONFIG };
