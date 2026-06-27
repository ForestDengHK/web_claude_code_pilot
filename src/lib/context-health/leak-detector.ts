/**
 * Detects when a model emitted a tool call as plain *text* instead of a real
 * structured tool_use block.
 *
 * When context saturates, the model can stop using native tool calling and
 * instead write the antml tool-call markup straight into its text output:
 *
 *   <invoke name="Bash">
 *   <parameter name="command">…</parameter>
 *   </invoke>
 *
 * The harness sees only a text reply (stop_reason: end_turn), nothing runs, and
 * the turn dies — "writes a command then stops". Worse, the leaked markup now
 * sits in the conversation history, so the model few-shots its own mistake and
 * every later turn repeats it. It's a reliable "this session has degraded,
 * start a fresh one" signal.
 *
 * We require BOTH the `<invoke name=…>` opener and a `<parameter name=…>` /
 * `</invoke>` tag so ordinary prose that merely mentions `<invoke>` (or this
 * very file) doesn't trip the alarm. We also scan only the *text* segments of a
 * message — a real tool_use block's `command` input legitimately contains shell
 * text and must never be matched.
 */

const INVOKE_OPEN = /<invoke\s+name\s*=/i;
const INVOKE_PART = /<parameter\s+name\s*=|<\/invoke>/i;

function isLeakedToolCallText(text: string): boolean {
  return INVOKE_OPEN.test(text) && INVOKE_PART.test(text);
}

/**
 * Pull the assistant's text segments out of a stored message `content`, which
 * may be a plain string, a JSON-encoded ContentBlock[] string, or an already
 * parsed ContentBlock[]. Only `text` blocks are returned.
 */
function extractTextSegments(content: unknown): string[] {
  if (typeof content === 'string') {
    const trimmed = content.trimStart();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return extractTextSegments(JSON.parse(content));
      } catch {
        return [content];
      }
    }
    return [content];
  }
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        out.push((block as { text: string }).text);
      }
    }
    return out;
  }
  return [];
}

/**
 * True when an assistant message contains a tool call that leaked into the text
 * stream instead of being executed.
 */
export function detectLeakedToolCall(content: unknown): boolean {
  return extractTextSegments(content).some(isLeakedToolCallText);
}
