export interface ChannelPermissionRequest {
  request_id: string; tool_name: string; description: string; input_preview: string;
}
export type ChannelEvent =
  | { kind: 'reply'; chatId: string; text: string }
  | { kind: 'permission_request'; request: ChannelPermissionRequest };

type Listener = (e: ChannelEvent) => void;
const KEY = '__codepilot_channel_bus__';
function buses(): Map<string, Set<Listener>> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY] as Map<string, Set<Listener>>;
}

export function subscribeChannelEvents(sessionId: string, fn: Listener): () => void {
  const map = buses();
  let set = map.get(sessionId);
  if (!set) { set = new Set(); map.set(sessionId, set); }
  set.add(fn);
  return () => { set!.delete(fn); if (set!.size === 0) map.delete(sessionId); };
}

export function publishChannelEvent(sessionId: string, e: ChannelEvent): void {
  const set = buses().get(sessionId);
  if (set) for (const fn of set) fn(e);
}
