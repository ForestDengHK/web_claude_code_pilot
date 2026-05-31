/**
 * T1 (channels) turn-end answer resolution.
 *
 * Background: the channel contract (scripts/channels-mcp-server.mjs) tells the
 * model to deliver its "full final answer" through the `reply` tool. During the
 * turn the model ALSO writes natural text blocks — but those are sometimes the
 * answer (it typed the answer, then restated it into reply) and sometimes only
 * working-notes / narration ("Let me confirm…", "Let me load the reply tool…")
 * with the real answer living ONLY in reply.
 *
 * The previous logic decided with a single boolean ("did any natural text
 * stream this turn?") and dropped the reply text whenever it was true. That
 * silently discarded the real answer in the working-notes case — the recurring
 * T1 truncation bug: the model streams narration as text, the answer goes into
 * reply, and the UI shows only the narration (ending on "Let me load the reply
 * tool to respond on the channel").
 *
 * Decide by CONTENT instead. Returns the text that finish() should emit:
 *   - no reply text                                  → '' (streamed text is all there is)
 *   - reply text already contained in streamed text  → '' (restatement; don't double-render)
 *   - otherwise                                      → reply text (narration ≠ answer; deliver it)
 *
 * Deliberately biased to NEVER drop a genuinely-new answer: reply is suppressed
 * only when the streamed text already fully contains it (the unambiguous
 * restatement case). The residual cost is a rare visible duplicate when the
 * model types the answer AND restates it into reply with different wording — a
 * duplicate is strictly better than a lost answer.
 */
export function resolveFinalReplyText(streamedText: string, replyText: string): string {
  const reply = (replyText ?? '').trim();
  if (!reply) return '';
  const normalize = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();
  const streamedNorm = normalize(streamedText);
  const replyNorm = normalize(reply);
  // Already shown verbatim (modulo whitespace) somewhere in the streamed text →
  // it's a restatement, so don't render it a second time.
  if (replyNorm && streamedNorm.includes(replyNorm)) return '';
  return reply;
}
