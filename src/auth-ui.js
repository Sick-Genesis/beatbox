// auth-ui.js
//
// The auth bar and modals. Interaction flow is lifted from
// live-love-vomit — inline sign-in fields in a corner bar, a modal for
// signup with a role selector, a "?" for password reset, a toast for
// feedback. The visual language is beatbox's own: hairline borders,
// monochrome, acid-green accent in dark mode.
//
// Markup is built in JS rather than added to index.html so the auth layer
// stays self-contained and the hand-authored SVG stays untouched.
// Styling lives in auth.css.

import {
  getSession, signIn, signUp, signOut, requestPasswordReset, onAuthChange,
} from './auth.js';
import { isConfigured } from './supabase-client.js';

// ── Toast ────────────────────────────────────────────────────────────────────

function toast(message, isError = false) {
  document.getElementById('auth-toast')?.remove();

  const el = document.createElement('div');
  el.id = 'auth-toast';
  el.className = `auth-toast${isError ? ' auth-toast--error' : ''}`;
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.textContent = message;
  document.body.appendChild(el);

  setTimeout(() => el.remove(), 4000);
}

// ── Modal ────────────────────────────────────────────────────────────────────

let lastFocused = null;

function openModal(html, onMount) {
  closeModal();
  lastFocused = document.activeElement;

  const overlay = document.createElement('div');
  overlay.id = 'auth-modal-overlay';
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `<div class="auth-modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', escToClose);

  // Focus the first field so the modal is usable without reaching for the
  // mouse — the original opened without focus and it was easy to miss.
  overlay.querySelector('input')?.focus();

  onMount?.(overlay);
}

function escToClose(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  document.getElementById('auth-modal-overlay')?.remove();
  document.removeEventListener('keydown', escToClose);
  lastFocused?.focus?.();
  lastFocused = null;
}

function field(id, label, type = 'text', extra = '') {
  return `
    <label class="auth-field" for="${id}">
      <span>${label}</span>
      <input id="${id}" type="${type}" ${extra}/>
    </label>`;
}

// ── Sign up ──────────────────────────────────────────────────────────────────

export function openSignUp() {
  openModal(`
    <h2 class="auth-modal__title">Create account</h2>
    ${field('su-email', 'email', 'email', 'autocomplete="email" placeholder="you@example.com"')}
    ${field('su-handle', 'handle', 'text', 'autocomplete="username" placeholder="3–30 letters, numbers or _"')}
    ${field('su-pass', 'password', 'password', 'autocomplete="new-password" placeholder="at least 8 characters"')}
    <p class="auth-note">
      You can license and trade beats straight away. Uploading your own
      unlocks the first time you post one.
    </p>
    <p class="auth-error" id="su-error" role="alert"></p>
    <div class="auth-actions">
      <button class="auth-btn" id="su-cancel" type="button">cancel</button>
      <button class="auth-btn auth-btn--primary" id="su-submit" type="button">create</button>
    </div>
  `, (overlay) => {
    overlay.querySelector('#su-cancel').addEventListener('click', closeModal);
    overlay.querySelector('#su-submit').addEventListener('click', submitSignUp);
    overlay.querySelector('#su-pass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitSignUp();
    });
  });
}

async function submitSignUp() {
  const overlay = document.getElementById('auth-modal-overlay');
  const err = overlay.querySelector('#su-error');
  const btn = overlay.querySelector('#su-submit');
  err.textContent = '';

  const email = overlay.querySelector('#su-email').value;
  const handle = overlay.querySelector('#su-handle').value;
  const password = overlay.querySelector('#su-pass').value;

  btn.disabled = true;
  try {
    const { needsEmailConfirmation } = await signUp({
      email, password, handle, displayName: handle,
    });
    closeModal();
    toast(needsEmailConfirmation
      ? 'Check your email to confirm the account.'
      : `Signed in as ${handle || email}.`);
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
  }
}

// ── Password reset ───────────────────────────────────────────────────────────

export function openPasswordReset(prefill = '') {
  openModal(`
    <h2 class="auth-modal__title">Reset password</h2>
    ${field('fp-email', 'email', 'email', `value="${prefill}" autocomplete="email"`)}
    <p class="auth-error" id="fp-error" role="alert"></p>
    <div class="auth-actions">
      <button class="auth-btn" id="fp-cancel" type="button">cancel</button>
      <button class="auth-btn auth-btn--primary" id="fp-submit" type="button">send link</button>
    </div>
  `, (overlay) => {
    overlay.querySelector('#fp-cancel').addEventListener('click', closeModal);
    overlay.querySelector('#fp-submit').addEventListener('click', submitReset);
    overlay.querySelector('#fp-email').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitReset();
    });
  });
}

async function submitReset() {
  const overlay = document.getElementById('auth-modal-overlay');
  const err = overlay.querySelector('#fp-error');
  const email = overlay.querySelector('#fp-email').value;

  try {
    await requestPasswordReset(email);
    closeModal();
    // Deliberately does not confirm whether the address exists.
    toast('If that address has an account, a reset link is on its way.');
  } catch (e) {
    err.textContent = e.message;
  }
}

// ── Auth bar ─────────────────────────────────────────────────────────────────

function ensureBar() {
  let bar = document.getElementById('auth-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'auth-bar';
    bar.className = 'auth-bar';
    document.body.appendChild(bar);
  }
  return bar;
}

async function renderBar(session) {
  const bar = ensureBar();
  const state = session ?? await getSession();

  if (state) {
    // Role is not shown here — it reads as a label the user didn't choose,
    // and "buyer" just means "hasn't uploaded yet". It belongs in profile
    // settings, not the header.
    bar.innerHTML = `
      <span class="auth-bar__who">@${state.handle || state.displayName}</span>
      <button class="auth-btn" id="ab-signout" type="button">sign out</button>`;
    bar.querySelector('#ab-signout').addEventListener('click', async () => {
      await signOut();
      toast('Signed out.');
    });
    return;
  }

  bar.innerHTML = `
    <input id="ab-email" type="email" placeholder="email" autocomplete="email" aria-label="email"/>
    <input id="ab-pass" type="password" placeholder="password" autocomplete="current-password" aria-label="password"/>
    <button class="auth-btn auth-btn--primary" id="ab-signin" type="button">sign in</button>
    <button class="auth-btn" id="ab-signup" type="button">sign up</button>
    <button class="auth-btn auth-btn--icon" id="ab-forgot" type="button"
            title="Forgot password?" aria-label="Forgot password">?</button>`;

  const submit = async () => {
    const email = bar.querySelector('#ab-email').value;
    const password = bar.querySelector('#ab-pass').value;
    if (!email || !password) return toast('Enter your email and password.', true);

    try {
      const s = await signIn({ email, password });
      toast(`Signed in as ${s.handle || s.displayName}.`);
    } catch (e) {
      toast(e.message, true);
    }
  };

  bar.querySelector('#ab-signin').addEventListener('click', submit);
  bar.querySelector('#ab-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  bar.querySelector('#ab-signup').addEventListener('click', () => openSignUp());
  bar.querySelector('#ab-forgot').addEventListener('click', () =>
    openPasswordReset(bar.querySelector('#ab-email').value));
}

/** Mount the auth bar and keep it in sync with the session. */
export function initAuthUI() {
  if (!isConfigured) return;   // no backend, nothing to sign into
  renderBar();
  onAuthChange((session) => renderBar(session));
}
