// reports-repo.js
//
// Takedown and dispute reports.
//
// Filing does NOT require an account. A rights holder who has never used
// beatbox must still be able to complain — if the takedown process is only
// usable by registered users, it is not usable by the people most likely
// to need it.
//
// Nothing here resolves a report. Acting on one (withdrawing a beat,
// upholding or rejecting a claim) is a moderation action that runs with
// elevated privileges, deliberately outside client code.

import { supabase, isConfigured } from './supabase-client.js';

export const REPORT_KINDS = [
  'copyright',
  'uncleared_sample',
  'impersonation',
  'trade_dispute',
  'other',
];

/**
 * File a report against a beat or a completed trade.
 *
 * `reporterEmail` is required when nobody is signed in — otherwise there
 * is no way to respond to the claim, which makes the report useless to
 * everyone including the person filing it.
 */
export async function fileReport({
  kind,
  beatId = null,
  tradeId = null,
  claim,
  evidenceUrl = '',
  reporterName = '',
  reporterEmail = '',
}) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  if (!REPORT_KINDS.includes(kind)) {
    throw new Error(`Report kind must be one of: ${REPORT_KINDS.join(', ')}.`);
  }
  if (!beatId && !tradeId) {
    throw new Error('A report needs to name the beat or trade it concerns.');
  }
  if (!claim?.trim()) {
    throw new Error('Describe what the problem is so it can be reviewed.');
  }

  const { data: auth } = await supabase.auth.getUser();
  const user = auth?.user ?? null;

  if (!user && !reporterEmail.trim()) {
    throw new Error(
      'Add an email address so we can reach you about this report.'
    );
  }

  const { data, error } = await supabase
    .from('reports')
    .insert({
      reporter_id: user?.id ?? null,
      reporter_name: reporterName.trim() || null,
      reporter_email: reporterEmail.trim() || null,
      kind,
      beat_id: beatId,
      trade_id: tradeId,
      claim: claim.trim(),
      evidence_url: evidenceUrl.trim() || null,
    })
    .select('id, kind, status, created_at')
    .single();

  if (error) throw new Error(`Could not file report: ${error.message}`);
  return data;
}

/**
 * Reports visible to the signed-in user: ones they filed, plus any filed
 * against beats they own. RLS enforces this; the query just orders them.
 */
export async function listReports() {
  if (!isConfigured) return [];

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return [];

  const { data, error } = await supabase
    .from('reports')
    .select(`
      id, kind, status, claim, evidence_url, created_at, resolved_at,
      resolution_note, reporter_id,
      beat:beat_id ( id, title, artist, withdrawn_at )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[beatbox] Could not load reports:', error.message);
    return [];
  }
  return data || [];
}

/** Withdraw a report you filed. */
export async function withdrawReport(reportId) {
  if (!isConfigured) throw new Error('Supabase is not configured.');

  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) throw new Error('You need to be signed in.');

  // No update policy exists on reports, so this will only succeed once a
  // moderation path is added. Kept here so the UI has something to call.
  const { error } = await supabase
    .from('reports')
    .update({ status: 'withdrawn', resolved_at: new Date().toISOString() })
    .eq('id', reportId)
    .eq('reporter_id', auth.user.id);

  if (error) throw new Error(`Could not withdraw report: ${error.message}`);
}
