// auth.js
//
// Session handling, shaped after the auth flow in live-love-vomit —
// inline auth bar, modal signup, role selector — but backed by Supabase
// rather than a hand-rolled Express + JWT server.
//
// Why the backend differs: every row-level security policy in this project
// is written against auth.uid() from a Supabase-issued token. Swapping in
// self-signed JWTs would mean rewriting all of them as application
// middleware, including the atomic trade settlement. The UI is the part
// worth porting; the plumbing underneath is not.
//
// Two concrete improvements that come for free:
//   - Refresh-token rotation and short expiry, rather than a static 7-day
//     token sitting in localStorage until it lapses.
//   - Password reset over real email, rather than a link logged to the
//     server console.

import { supabase, isConfigured } from './supabase-client.js';

const listeners = new Set();
let cachedProfile = null;

/** Subscribe to session changes. Returns an unsubscribe function. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(state) {
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (e) {
      console.error('[beatbox] auth listener failed:', e);
    }
  });
}

/**
 * The signed-in user plus their profile row, or null.
 *
 * The role lives on the profile, not in a token claim, so a role change
 * takes effect on the next read rather than whenever a token expires.
 */
export async function getSession() {
  if (!isConfigured) return null;

  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) {
    cachedProfile = null;
    return null;
  }

  if (!cachedProfile || cachedProfile.id !== user.id) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, handle, display_name, bio, role')
      .eq('id', user.id)
      .single();
    cachedProfile = profile ?? null;
  }

  return {
    id: user.id,
    email: user.email,
    displayName: cachedProfile?.display_name ?? 'producer',
    handle: cachedProfile?.handle ?? null,
    role: cachedProfile?.role ?? 'buyer',
    isProducer: cachedProfile?.role === 'producer',
  };
}

/**
 * Create an account.
 *
 * `role` is passed as signup metadata and applied by the handle_new_user()
 * trigger, which coerces anything unexpected to 'buyer'. It is never
 * trusted as sent — the database decides.
 */
export async function signUp({ email, password, displayName, handle, role = 'buyer' }) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  if (!email?.trim()) throw new Error('Enter an email address.');
  if (!password || password.length < 8) {
    throw new Error('Passwords need to be at least 8 characters.');
  }
  if (handle && !/^[a-zA-Z0-9_]{3,30}$/.test(handle)) {
    throw new Error('Handles can use 3–30 letters, numbers or underscores.');
  }

  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        display_name: displayName?.trim() || handle?.trim() || 'producer',
        handle: handle?.trim() || '',
        role: role === 'producer' ? 'producer' : 'buyer',
      },
    },
  });

  if (error) throw new Error(friendlyError(error.message));

  cachedProfile = null;
  const session = await getSession();
  emit(session);

  // With email confirmation enabled there is no session until the link is
  // clicked. Tell the caller which happened so the UI can say so.
  return {
    session,
    needsEmailConfirmation: !data.session,
  };
}

export async function signIn({ email, password }) {
  if (!isConfigured) throw new Error('Supabase is not configured.');
  if (!email?.trim() || !password) {
    throw new Error('Enter your email and password.');
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) throw new Error(friendlyError(error.message));

  cachedProfile = null;
  const session = await getSession();
  emit(session);
  return session;
}

export async function signOut() {
  if (!isConfigured) return;
  await supabase.auth.signOut();
  cachedProfile = null;
  emit(null);
}

/**
 * Send a password reset email.
 *
 * Resolves the same way whether or not the address exists — telling a
 * caller which emails are registered is an account-enumeration leak.
 */
export async function requestPasswordReset(email) {
  if (!isConfigured) throw new Error('Supabase is not configured.');
  if (!email?.trim()) throw new Error('Enter your email address.');

  await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}/reset-password`,
  });
}

/** Update display name / handle / bio. Role is pinned by a DB trigger. */
export async function updateProfile({ displayName, handle, bio }) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) throw new Error('You need to be signed in.');

  const patch = {};
  if (displayName !== undefined) patch.display_name = displayName.trim();
  if (handle !== undefined) patch.handle = handle.trim() || null;
  if (bio !== undefined) patch.bio = bio.trim() || null;

  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', user.id);

  if (error) {
    if (error.code === '23505') throw new Error('That handle is already taken.');
    throw new Error(`Could not save profile: ${error.message}`);
  }

  cachedProfile = null;
  emit(await getSession());
}

/** Supabase error strings are terse; make the common ones readable. */
function friendlyError(message) {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) {
    return 'That email and password combination did not work.';
  }
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'There is already an account with that email.';
  }
  if (m.includes('email rate limit') || m.includes('over_email_send_rate_limit')) {
    return 'Too many attempts just now — try again in a few minutes.';
  }
  return message;
}

// Keep listeners in sync when a token refreshes or a session is restored
// in another tab.
if (isConfigured) {
  supabase.auth.onAuthStateChange(async (event) => {
    if (event === 'SIGNED_OUT') {
      cachedProfile = null;
      emit(null);
    } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      emit(await getSession());
    }
  });
}
