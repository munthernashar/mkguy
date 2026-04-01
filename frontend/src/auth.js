import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';

export const getBaseUrl = () => `${window.location.origin}${window.location.pathname}`;

export const hasAuthCode = () => Boolean(getParam('code'));

export const buildViewUrl = (view, params = {}) => {
  const url = new URL(getBaseUrl());
  url.searchParams.set('view', view);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};

export const getCurrentView = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('view') ?? 'health';
};

export const getParam = (name) => {
  const url = new URL(window.location.href);
  const queryVal = url.searchParams.get(name);
  if (queryVal) return queryVal;

  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  const hashParams = new URLSearchParams(hash);
  return hashParams.get(name);
};

export const readAuthError = () => {
  const errorCode = getParam('error_code');
  const description = getParam('error_description');
  if (!errorCode) return null;

  if (errorCode === 'otp_expired') {
    return 'Der Magic-Link ist abgelaufen oder bereits verwendet. Bitte fordere einen neuen Link an.';
  }

  return description ? decodeURIComponent(description.replace(/\+/g, ' ')) : 'Authentifizierung fehlgeschlagen.';
};

export const signInWithMagicLink = async (email) => {
  const next = getBaseUrl();
  const callbackUrl = buildViewUrl('auth-callback', { next });
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: callbackUrl,
    },
  });

  if (error) {
    logger.warn('magic_link_failed', { reason: error.message, status: error.status });

    if (error.status === 429) {
      throw new Error('Zu viele Versuche. Bitte warte 60 Sekunden und fordere dann erneut einen Magic-Link an.');
    }

    throw new Error('Anmeldung fehlgeschlagen. Bitte erneut versuchen.');
  }
};

export const signInWithPassword = async (email, password) => {
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    logger.warn('password_login_failed', { reason: error.message, status: error.status });
    throw new Error('Login mit E-Mail/Passwort fehlgeschlagen.');
  }
};

export const signUpWithPassword = async (email, password) => {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    logger.warn('password_signup_failed', { reason: error.message, status: error.status });
    throw new Error('Registrierung fehlgeschlagen.');
  }
};

export const signOut = async () => {
  const { error } = await supabase.auth.signOut();
  if (error) {
    logger.error('logout_failed', { reason: error.message });
    throw new Error('Logout fehlgeschlagen.');
  }
};

export const exchangeAuthCode = async () => {
  const code = getParam('code');
  if (!code) {
    return null;
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const { data: currentSession } = await supabase.auth.getSession();
    if (currentSession?.session) {
      return currentSession.session;
    }

    logger.warn('exchange_code_failed', { reason: error.message });
    throw new Error('Der Login-Link ist ungültig oder abgelaufen.');
  }

  return data.session;
};

export const getSession = async () => {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    logger.warn('session_fetch_failed', { reason: error.message });
    return null;
  }
  return data.session;
};

export const writeAuditLog = async (action, details = {}) => {
  try {
    await supabase.functions.invoke('audit-log-write', {
      body: {
        action,
        details,
      },
    });
  } catch (error) {
    logger.warn('audit_log_emit_failed', { action, error: String(error) });
  }
};
