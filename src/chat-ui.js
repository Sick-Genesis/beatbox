// chat-ui.js
//
// Direct-message chat, ported from live-love-vomit's floating overlay +
// draggable chat box — but restyled in beatbox's own hairline/sharp-border
// language (no rounded corners, no shadows, hotpink/--accent for state)
// instead of live-love-vomit's neon-green terminal look, and backed by
// Supabase Realtime instead of a raw WebSocket server.
//
// Scope, deliberately smaller than the source: no friend requests, no
// blocking, no groups, no presence. Anyone can message anyone by handle —
// this is a marketplace, not a social network, and the one thing it needs
// to replace is the "message the producer" stub in list-view.js.
//
// Markup is built in JS, same pattern as auth-ui.js. Styling lives in chat.css.

import {
  openDm, listConversations, listMessages, sendMessage,
  subscribeToMessages, subscribeToInbox, searchMessageableUsers,
} from './chat-repo.js';
import { getSession, onAuthChange } from './auth.js';
import { isConfigured } from './supabase-client.js';

let panel = null;
let dmWindow = null;
let currentUserId = null;
let activeConversationId = null;
let unsubscribeActive = null;
let unsubscribeInbox = null;
const unreadByConversation = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function nameOf(profile) {
  return profile?.handle || profile?.display_name || 'someone';
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function totalUnread() {
  let n = 0;
  for (const v of unreadByConversation.values()) n += v;
  return n;
}

function updateLauncherBadge() {
  const badge = document.getElementById('chat-launcher-badge');
  if (!badge) return;
  const n = totalUnread();
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.classList.toggle('is-visible', n > 0);
}

// ── Launcher badge (over the sidebar envelope) ────────────────────────────────

function mountLauncherBadge() {
  if (document.getElementById('chat-launcher-badge')) return;
  const icon = document.querySelector('.chat-launcher-icon');
  if (!icon) return;

  const badge = document.createElement('span');
  badge.id = 'chat-launcher-badge';
  badge.className = 'chat-launcher-badge';
  document.body.appendChild(badge);

  const place = () => {
    const svg = document.querySelector('svg.layout');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    // Icon centre is at data-cx=2.5, data-cy=34.4 in the 0..100 viewBox.
    badge.style.left = `${r.left + (4.4 / 100) * r.width}px`;
    badge.style.top = `${r.top + (33 / 100) * r.height}px`;
  };
  place();
  window.addEventListener('resize', place);

  icon.addEventListener('click', () => togglePanel());
}

// ── Contacts panel ───────────────────────────────────────────────────────────

function ensurePanel() {
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'chat-panel';
  panel.className = 'chat-panel';
  panel.innerHTML = `
    <div class="chat-panel__bar" id="chat-panel-bar">
      <span>messages</span>
      <button class="chat-panel__x" type="button" aria-label="Close">✕</button>
    </div>
    <div class="chat-panel__search">
      <input type="text" id="chat-search-input" placeholder="find a producer by handle…" autocomplete="off"/>
    </div>
    <div class="chat-panel__results" id="chat-search-results"></div>
    <div class="chat-panel__section">conversations</div>
    <div class="chat-panel__list" id="chat-conversation-list"></div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('.chat-panel__x').addEventListener('click', closePanel);

  const searchInput = panel.querySelector('#chat-search-input');
  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(searchInput.value), 200);
  });

  return panel;
}

async function runSearch(query) {
  const results = panel.querySelector('#chat-search-results');
  const q = query.trim();
  if (!q) { results.innerHTML = ''; return; }

  const users = await searchMessageableUsers(q);
  results.innerHTML = users.length
    ? users.map((u) => `
        <button type="button" class="chat-result" data-id="${u.id}" data-handle="${escapeHtml(u.handle)}">
          @${escapeHtml(u.handle)}
        </button>`).join('')
    : '<p class="chat-panel__empty">No one found.</p>';

  results.querySelectorAll('.chat-result').forEach((btn) => {
    btn.addEventListener('click', () => startDm(btn.dataset.id, btn.dataset.handle));
  });
}

async function refreshConversationList() {
  const list = panel.querySelector('#chat-conversation-list');
  const conversations = await listConversations();

  list.innerHTML = conversations.length
    ? conversations.map((c) => {
        const unread = unreadByConversation.get(c.id) || 0;
        const preview = c.lastMessage
          ? escapeHtml(c.lastMessage.text).slice(0, 48)
          : 'Say hello.';
        return `
          <button type="button" class="chat-contact" data-id="${c.id}" data-other-id="${c.other.id}" data-other-name="${escapeHtml(nameOf(c.other))}">
            <span class="chat-contact__name">@${escapeHtml(nameOf(c.other))}</span>
            <span class="chat-contact__preview">${preview}</span>
            ${unread > 0 ? `<span class="chat-contact__unread">${unread}</span>` : ''}
          </button>`;
      }).join('')
    : '<p class="chat-panel__empty">No conversations yet — search a handle above.</p>';

  list.querySelectorAll('.chat-contact').forEach((btn) => {
    btn.addEventListener('click', () => openConversation(btn.dataset.id, btn.dataset.otherName));
  });
}

function togglePanel() {
  ensurePanel();
  const opening = !panel.classList.contains('is-open');
  panel.classList.toggle('is-open', opening);
  if (opening) refreshConversationList();
}

function closePanel() {
  panel?.classList.remove('is-open');
}

// ── DM window ────────────────────────────────────────────────────────────────

function ensureDmWindow() {
  if (dmWindow) return dmWindow;

  dmWindow = document.createElement('div');
  dmWindow.id = 'chat-dm';
  dmWindow.className = 'chat-dm';
  dmWindow.innerHTML = `
    <div class="chat-dm__bar" id="chat-dm-bar">
      <span id="chat-dm-name"></span>
      <button class="chat-dm__x" type="button" aria-label="Close">✕</button>
    </div>
    <div class="chat-dm__messages" id="chat-dm-messages"></div>
    <div class="chat-dm__input-row">
      <input type="text" id="chat-dm-input" placeholder="message…" autocomplete="off"/>
      <button type="button" id="chat-dm-send">send</button>
    </div>
  `;
  document.body.appendChild(dmWindow);

  dmWindow.querySelector('.chat-dm__x').addEventListener('click', closeDm);

  const input = dmWindow.querySelector('#chat-dm-input');
  const send = () => {
    const text = input.value;
    input.value = '';
    if (!activeConversationId) return;
    sendMessage(activeConversationId, text).catch((e) => appendSystemLine(e.message));
  };
  dmWindow.querySelector('#chat-dm-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });

  wireDrag(dmWindow, dmWindow.querySelector('#chat-dm-bar'));

  return dmWindow;
}

function appendMessage(message) {
  const list = dmWindow.querySelector('#chat-dm-messages');
  const mine = message.sender_id === currentUserId;
  const row = document.createElement('div');
  row.className = `chat-msg ${mine ? 'chat-msg--mine' : 'chat-msg--theirs'}`;
  row.innerHTML = `
    <span class="chat-msg__text"></span>
    <span class="chat-msg__time">${formatTime(message.created_at)}</span>`;
  row.querySelector('.chat-msg__text').textContent = message.text;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function appendSystemLine(text) {
  const list = dmWindow?.querySelector('#chat-dm-messages');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'chat-msg chat-msg--system';
  row.textContent = text;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

async function openConversation(conversationId, otherName) {
  ensureDmWindow();
  activeConversationId = conversationId;
  unreadByConversation.delete(conversationId);
  updateLauncherBadge();
  refreshConversationList();

  dmWindow.querySelector('#chat-dm-name').textContent = `@${otherName}`;
  const list = dmWindow.querySelector('#chat-dm-messages');
  list.innerHTML = '';
  dmWindow.classList.add('is-open');

  unsubscribeActive?.();
  const messages = await listMessages(conversationId);
  messages.forEach(appendMessage);

  unsubscribeActive = subscribeToMessages(conversationId, (message) => {
    // Avoid double-render of the message the sender just posted locally —
    // sendMessage()'s own insert already round-trips through Realtime, so
    // only the OTHER side's arrival needs rendering here for the sender.
    // Simpler and correct either way: re-render is idempotent per id.
    if (dmWindow.querySelector(`[data-msg-id="${message.id}"]`)) return;
    appendMessage(message);
  });
}

/**
 * Start (or resume) a DM from a user id, e.g. from search results or
 * "message the producer". Throws with a caller-facing message on failure
 * (not signed in, messaging yourself, the user no longer exists, etc.) so
 * callers like list-view.js's flash() can show it instead of it vanishing
 * into the console.
 */
export async function startDm(otherUserId, otherName) {
  if (!isConfigured) throw new Error('Messaging is not available right now.');

  // Cheap local check before round-tripping to the RPC: the common case is
  // an anonymous visitor clicking "message producer", and the friendlier
  // copy for that belongs here rather than the server's generic auth error.
  const session = await getSession();
  if (!session) throw new Error('Sign in to message the producer.');

  const conversation = await openDm(otherUserId);
  ensurePanel();
  panel.classList.add('is-open');
  await openConversation(conversation.id, otherName || 'producer');
}

function closeDm() {
  dmWindow?.classList.remove('is-open');
  unsubscribeActive?.();
  unsubscribeActive = null;
  activeConversationId = null;
}

// ── Dragging (same recipe as upload-toggle.js: lift to fixed, track pointer) ──

function wireDrag(box, handle) {
  let dragging = false;
  let startX = 0, startY = 0;
  let placed = false;

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    if (!placed) {
      const rect = box.getBoundingClientRect();
      box.style.position = 'fixed';
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.right = 'auto';
      box.style.bottom = 'auto';
      placed = true;
    }
    dragging = true;
    const rect = box.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    box.style.left = `${e.clientX - startX}px`;
    box.style.top = `${e.clientY - startY}px`;
  });

  handle.addEventListener('pointerup', (e) => {
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initChatUI() {
  if (!isConfigured) return;

  mountLauncherBadge();

  onAuthChange(async (session) => {
    unsubscribeInbox?.();
    unsubscribeInbox = null;
    currentUserId = session?.id ?? null;

    if (!session) {
      unreadByConversation.clear();
      updateLauncherBadge();
      return;
    }

    unsubscribeInbox = subscribeToInbox((message) => {
      if (message.sender_id === currentUserId) return; // our own send, ignore
      if (message.conversation_id === activeConversationId && dmWindow?.classList.contains('is-open')) {
        appendMessage(message);
        return;
      }
      unreadByConversation.set(
        message.conversation_id,
        (unreadByConversation.get(message.conversation_id) || 0) + 1,
      );
      updateLauncherBadge();
      if (panel?.classList.contains('is-open')) refreshConversationList();
    });
  });

  getSession().then((s) => { currentUserId = s?.id ?? null; });
}
