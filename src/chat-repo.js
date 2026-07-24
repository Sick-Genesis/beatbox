// chat-repo.js
//
// Direct messages: open DMs, no friend gate. Anyone can message anyone by
// handle — this backs both the "message the producer" button on a beat and
// the standalone chat launcher's contacts search.
//
// Realtime replaces what a WebSocket server would otherwise do: subscribing
// to a conversation's Postgres changes delivers new messages live.

import { supabase, isConfigured } from './supabase-client.js';
import { getSession } from './auth.js';

/** Find or create the DM with another user. One row per pair, enforced server-side. */
export async function openDm(otherUserId) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase.rpc('find_or_create_dm', {
    p_other_id: otherUserId,
  });

  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
  return data;
}

/**
 * The signed-in user's conversations, newest-active first, each with the
 * other member's profile and the last message for a preview line.
 */
export async function listConversations() {
  if (!isConfigured) return [];
  const session = await getSession();
  if (!session) return [];

  const { data, error } = await supabase
    .from('conversations')
    .select(`
      id, member_a, member_b, created_at, updated_at,
      a:member_a ( id, handle, display_name ),
      b:member_b ( id, handle, display_name )
    `)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[beatbox] Could not load conversations:', error.message);
    return [];
  }

  // Collapse member_a/member_b into "me" and "other", and attach the last
  // message so the contacts list can show a preview without a second round
  // trip per conversation.
  const conversations = (data || []).map((c) => ({
    id: c.id,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    other: c.member_a === session.id ? c.b : c.a,
  }));

  const ids = conversations.map((c) => c.id);
  if (!ids.length) return [];

  const { data: lastMessages } = await supabase
    .from('messages')
    .select('conversation_id, text, sender_id, created_at')
    .in('conversation_id', ids)
    .order('created_at', { ascending: false });

  const lastByConversation = new Map();
  for (const m of lastMessages || []) {
    if (!lastByConversation.has(m.conversation_id)) {
      lastByConversation.set(m.conversation_id, m);
    }
  }

  return conversations.map((c) => ({
    ...c,
    lastMessage: lastByConversation.get(c.id) ?? null,
  }));
}

/** Full message history for one conversation, oldest first. */
export async function listMessages(conversationId) {
  if (!isConfigured) return [];

  const { data, error } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[beatbox] Could not load messages:', error.message);
    return [];
  }
  return data || [];
}

/** Send a message. Delivery to the other member happens via Realtime, not the return value. */
export async function sendMessage(conversationId, text) {
  if (!isConfigured) throw new Error('Supabase is not configured.');
  const trimmed = text?.trim();
  if (!trimmed) throw new Error('Type a message first.');

  const session = await getSession();
  if (!session) throw new Error('You need to be signed in to message someone.');

  const { data, error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: session.id, text: trimmed })
    .select()
    .single();

  if (error) throw new Error(`Could not send message: ${error.message}`);
  return data;
}

/**
 * Live-subscribe to new messages in one conversation. Returns an unsubscribe
 * function. Filtering by conversation_id server-side keeps this to one
 * channel per open chat window rather than one firehose for every message
 * in the app.
 */
export function subscribeToMessages(conversationId, onMessage) {
  if (!isConfigured) return () => {};

  const channel = supabase
    .channel(`messages:${conversationId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => onMessage(payload.new),
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

/**
 * Live-subscribe to new messages ACROSS all of the signed-in user's
 * conversations, for the launcher's unread badge. Postgres RLS on the
 * subscription still applies, so this only ever sees rows the user can read.
 */
export function subscribeToInbox(onMessage) {
  if (!isConfigured) return () => {};

  const channel = supabase
    .channel('inbox')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => onMessage(payload.new),
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

/** Search users by handle prefix, to start a new DM. Excludes the caller server-side. */
export async function searchMessageableUsers(query) {
  if (!isConfigured || !query?.trim()) return [];

  const { data, error } = await supabase.rpc('search_messageable_users', {
    p_query: query.trim(),
  });

  if (error) {
    console.error('[beatbox] User search failed:', error.message);
    return [];
  }
  return data || [];
}
