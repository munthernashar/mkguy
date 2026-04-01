import { PUBLIC_CONFIG } from './config.js';
import { logger } from './logger.js';
import { supabase } from './supabaseClient.js';
import { getCurrentView, getParam, getSession, signInWithMagicLink, signOut, exchangeAuthCode, writeAuditLog, buildViewUrl } from './auth.js';

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
    <p class="muted">Melde dich mit einem Magic-Link an.</p>
    <form id="magic-link-form">
      <label for="email">E-Mail</label><br/>
      <input id="email" name="email" type="email" required placeholder="you@example.com" />
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

const statusPill = (status) => `<span class="status-pill status-${status}">${status}</span>`;

const BooksView = (session) => `
  <section class="card">
    <h2>Buchprofil & Dokumente</h2>
    <p class="muted">Buch anlegen und pro Buch PDF hochladen.</p>
    <form id="book-form">
      <label for="book-title">Buchtitel</label>
      <input id="book-title" name="title" placeholder="z. B. Deep Work" required />
      <label for="book-description">Beschreibung</label>
      <textarea id="book-description" name="description" rows="3" placeholder="Kurze Notizen zum Buch"></textarea>
      <button type="submit">Buch speichern</button>
      <p id="book-form-status" class="muted"></p>
    </form>
  </section>
  <section class="card">
    <h3>Meine Bücher (${session.user.email})</h3>
    <div id="books-list"><p class="muted">Lade Bücher…</p></div>
  </section>
`;

const SessionGuard = async (viewName) => {
  const session = await getSession();
  if (!session && ['health', 'books'].includes(viewName)) {
    navigate('login', { next: buildViewUrl(viewName) });
    return null;
  }
  return session;
};

const loadBooks = async () => {
  const booksRoot = document.getElementById('books-list');
  if (!booksRoot) return;

  const { data: books, error } = await supabase
    .from('books')
    .select('id,title,description,created_at,book_documents(id,file_name,parse_status,parse_error,created_at)')
    .order('created_at', { ascending: false });

  if (error) {
    booksRoot.innerHTML = `<p class="muted">Bücher konnten nicht geladen werden: ${error.message}</p>`;
    return;
  }

  if (!books?.length) {
    booksRoot.innerHTML = '<p class="muted">Noch keine Bücher vorhanden.</p>';
    return;
  }

  booksRoot.innerHTML = books.map((book) => {
    const docs = book.book_documents ?? [];
    const docsHtml = docs.length
      ? docs.map((doc) => `
        <div class="book-item">
          <div><strong>${doc.file_name ?? 'Dokument'}</strong> ${statusPill(doc.parse_status)}</div>
          ${doc.parse_error ? `<p class="muted">Fehler: ${doc.parse_error}</p>` : ''}
          <div class="inline-actions">
            <button data-action="start-analysis" data-document-id="${doc.id}">Analyse starten</button>
            <button data-action="restart-analysis" data-document-id="${doc.id}">Neu analysieren</button>
          </div>
        </div>
      `).join('')
      : '<p class="muted">Noch kein Dokument hochgeladen.</p>';

    return `
      <article class="book-item">
        <h4>${book.title}</h4>
        <p class="muted">${book.description ?? 'Keine Beschreibung.'}</p>
        <form data-upload-form="${book.id}">
          <input type="file" name="pdf" accept="application/pdf" required />
          <button type="submit">PDF hochladen</button>
          <p class="muted" data-upload-status="${book.id}"></p>
        </form>
        ${docsHtml}
      </article>
    `;
  }).join('');
};

const uploadBookPdf = async (bookId, file) => {
  const filePath = `${bookId}/${crypto.randomUUID()}-${file.name.replace(/\s+/g, '_')}`;

  const { error: uploadError } = await supabase.storage
    .from('book-pdfs')
    .upload(filePath, file, { contentType: file.type || 'application/pdf', upsert: false });

  if (uploadError) throw new Error(`Upload fehlgeschlagen: ${uploadError.message}`);

  const { data, error } = await supabase
    .from('book_documents')
    .insert({
      book_id: bookId,
      source_type: 'upload',
      source_uri: `book-pdfs/${filePath}`,
      file_name: file.name,
      mime_type: file.type || 'application/pdf',
      parse_status: 'uploaded',
      created_by: (await getSession())?.user.id,
      updated_by: (await getSession())?.user.id,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Dokument konnte nicht gespeichert werden: ${error.message}`);
  return data.id;
};

const triggerAnalysis = async (documentId, force = false) => {
  const { error } = await supabase.functions.invoke('start-pdf-analysis', { body: { document_id: documentId, force } });
  if (error) throw new Error(`Analyse konnte nicht gestartet werden: ${error.message}`);
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

  if (viewName === 'books' && session) {
    const form = document.getElementById('book-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.getElementById('book-form-status');
      const title = form.title.value.trim();
      const description = form.description.value.trim();
      const userId = session.user.id;

      const { error } = await supabase.from('books').insert({ title, description, created_by: userId, updated_by: userId });
      if (error) {
        status.textContent = `Buch konnte nicht gespeichert werden: ${error.message}`;
        return;
      }
      status.textContent = 'Buch gespeichert.';
      form.reset();
      await loadBooks();
    });

    if (!booksHandlersBound) {
      app.addEventListener('submit', async (event) => {
        const uploadForm = event.target.closest('form[data-upload-form]');
        if (!uploadForm) return;
        event.preventDefault();
        const bookId = uploadForm.dataset.uploadForm;
        const file = uploadForm.querySelector('input[type="file"]').files?.[0];
        const status = document.querySelector(`[data-upload-status="${bookId}"]`);
        if (!file) return;

        try {
          status.textContent = 'Upload läuft…';
          const documentId = await uploadBookPdf(bookId, file);
          status.textContent = 'Upload fertig, Dokument wurde als uploaded erfasst.';
          await triggerAnalysis(documentId, false);
          await loadBooks();
        } catch (error) {
          status.textContent = error.message;
        }
      });

      app.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const docId = button.dataset.documentId;
        const force = button.dataset.action === 'restart-analysis';
        try {
          await triggerAnalysis(docId, force);
          await loadBooks();
        } catch (error) {
          alert(error.message);
        }
      });

      booksHandlersBound = true;
    }
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

  if (viewName === 'books') {
    renderLayout(BooksView(session));
    bindEvents(viewName, session);
    await loadBooks();
    return;
  }

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
