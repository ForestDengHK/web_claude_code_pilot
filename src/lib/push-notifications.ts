import webpush from 'web-push';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAllPushSubscriptions, deletePushSubscription } from './db';

const VAPID_KEYS_PATH = path.join(
  os.homedir(),
  '.codepilot',
  'vapid-keys.json',
);

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Get or generate VAPID keys. Keys are stored in ~/.codepilot/vapid-keys.json.
 * Auto-generates on first access.
 */
export function getVapidKeys(): VapidKeys {
  if (fs.existsSync(VAPID_KEYS_PATH)) {
    const raw = fs.readFileSync(VAPID_KEYS_PATH, 'utf-8');
    return JSON.parse(raw) as VapidKeys;
  }

  const dir = path.dirname(VAPID_KEYS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const keys = webpush.generateVAPIDKeys();
  const vapidKeys: VapidKeys = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: 'mailto:codepilot@localhost',
  };

  fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2));
  return vapidKeys;
}

interface PushPayload {
  type: 'task_complete' | 'permission_request' | 'input_request';
  sessionId: string;
  sessionTitle: string;
  message: string;
  requestId?: string;
}

/**
 * Send a push notification to all subscribed devices.
 * Cleans up expired subscriptions (410 Gone).
 * Never throws -- push failure must not break the main flow.
 */
export async function sendPushNotification(payload: PushPayload): Promise<void> {
  try {
    const subscriptions = getAllPushSubscriptions();
    if (subscriptions.length === 0) return;

    const vapidKeys = getVapidKeys();
    webpush.setVapidDetails(vapidKeys.subject, vapidKeys.publicKey, vapidKeys.privateKey);

    const { title, body, url } = buildNotificationContent(payload);

    const notificationPayload = JSON.stringify({
      type: payload.type,
      sessionId: payload.sessionId,
      title,
      body,
      url,
    });

    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
          },
          notificationPayload,
        ),
      ),
    );

    // Clean up expired subscriptions
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = (result.reason as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          deletePushSubscription(subscriptions[index].endpoint);
        }
      }
    });
  } catch {
    // Never let push errors break the main flow
  }
}

function buildNotificationContent(payload: PushPayload): {
  title: string;
  body: string;
  url: string;
} {
  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + '\u2026' : s;

  switch (payload.type) {
    case 'task_complete':
      return {
        title: `\u2705 ${payload.sessionTitle || 'CodePilot'}`,
        body: truncate(payload.message, 100),
        url: `/chat/${payload.sessionId}`,
      };
    case 'permission_request':
      return {
        title: '\uD83D\uDD10 \u9700\u8981\u5BA1\u6279',
        body: truncate(payload.message, 100),
        url: `/chat/${payload.sessionId}?approve=${payload.requestId || ''}`,
      };
    case 'input_request':
      return {
        title: '\u2753 \u9700\u8981\u56DE\u590D',
        body: truncate(payload.message, 100),
        url: `/chat/${payload.sessionId}?input=${payload.requestId || ''}`,
      };
  }
}
