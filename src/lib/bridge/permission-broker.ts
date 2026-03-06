/**
 * Permission broker — bridges Claude's permission requests to IM inline buttons.
 *
 * Flow:
 * 1. Claude SDK emits permission_request during streaming
 * 2. ConversationEngine calls forwardPermissionRequest()
 * 3. Broker sends IM message with inline buttons (allow/deny)
 * 4. User taps button -> callback_query -> handlePermissionCallback()
 * 5. Broker calls resolvePendingPermission() from the existing registry
 */

import { insertPermissionLink, getPermissionLink, markPermissionLinkResolved } from './bridge-db';
import type { BaseChannelAdapter } from './channel-adapter';
import type { ChannelAddress, InlineButton } from './types';

// Simple HTML escape for safe display in adapters that support HTML.
// Kept inline to avoid coupling to any specific adapter's utils.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Forward a permission request to the IM channel as a message with inline buttons.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  params: {
    permissionRequestId: string;
    toolName: string;
    description?: string;
  },
): Promise<void> {
  // Build inline buttons (single row)
  const buttons: InlineButton[] = [
    { text: 'Allow', callbackData: `perm:allow:${params.permissionRequestId}` },
    { text: 'Deny', callbackData: `perm:deny:${params.permissionRequestId}` },
    { text: 'Always allow', callbackData: `perm:always:${params.permissionRequestId}` },
  ];

  // Build message text (HTML format — adapters that don't support HTML can strip tags)
  const lines = ['<b>Permission Request</b>'];
  lines.push(`Tool: <code>${escapeHtml(params.toolName)}</code>`);
  if (params.description) {
    lines.push(`\n${escapeHtml(params.description)}`);
  }
  const text = lines.join('\n');

  // Send via adapter — buttons are a single row
  const result = await adapter.send({
    address,
    text,
    parseMode: 'HTML',
    inlineButtons: [buttons],
  });

  // Record permission link for callback resolution
  if (result.ok && result.messageId) {
    insertPermissionLink({
      permissionRequestId: params.permissionRequestId,
      channelType: address.channelType,
      chatId: address.chatId,
      messageId: result.messageId,
      toolName: params.toolName,
      suggestions: buttons.map(b => b.text).join(','),
    });
  }
}

/**
 * Handle a callback from an inline button press.
 * Returns the resolution ('allow' | 'deny' | 'always') or null if invalid.
 */
export async function handlePermissionCallback(
  adapter: BaseChannelAdapter,
  callbackData: string,
  callbackQueryId: string,
): Promise<{ action: string; permissionRequestId: string } | null> {
  // Parse callback data
  const parsed = parsePermissionCallback(callbackData);
  if (!parsed) return null;

  const { action, permissionRequestId } = parsed;

  // Check if already resolved
  const link = getPermissionLink(permissionRequestId);
  if (!link) {
    await adapter.answerCallback(callbackQueryId, 'Permission request not found');
    return null;
  }
  if (link.resolved) {
    await adapter.answerCallback(callbackQueryId, 'Already resolved');
    return null;
  }

  // Mark as resolved in our DB
  markPermissionLinkResolved(permissionRequestId);

  // Try to resolve in the existing permission registry
  try {
    const { resolvePendingPermission } = await import('../permission-registry');
    if (resolvePendingPermission) {
      const allowed = action === 'allow' || action === 'always';
      resolvePendingPermission(permissionRequestId, {
        behavior: allowed ? 'allow' : 'deny',
      });
    }
  } catch {
    // permission-registry may not exist yet or may have different API
    // That's OK — we still recorded the resolution in our DB
  }

  // Answer the callback
  const label = action === 'deny' ? 'Denied' : action === 'always' ? 'Always allowed' : 'Allowed';
  await adapter.answerCallback(callbackQueryId, label);

  return { action, permissionRequestId };
}

/**
 * Parse permission callback data. Returns null if not a permission callback.
 */
export function parsePermissionCallback(callbackData: string): { action: string; permissionRequestId: string } | null {
  const match = callbackData.match(/^perm:(allow|deny|always):([0-9a-f-]{32,64})$/i);
  if (!match) return null;
  return { action: match[1], permissionRequestId: match[2] };
}
