'use client';

import { useEffect, useState, useCallback } from 'react';

interface SubscriptionInfo {
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (ua.includes('iPhone') || ua.includes('iPad')) {
    if (ua.includes('CriOS')) return 'Chrome iOS';
    if (ua.includes('FxiOS')) return 'Firefox iOS';
    return 'Safari iOS';
  }
  if (ua.includes('Android')) {
    if (ua.includes('Chrome')) return 'Chrome Android';
    if (ua.includes('Firefox')) return 'Firefox Android';
    return 'Android Browser';
  }
  if (ua.includes('Macintosh') || ua.includes('Mac OS')) {
    if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome macOS';
    if (ua.includes('Firefox')) return 'Firefox macOS';
    if (ua.includes('Safari')) return 'Safari macOS';
    return 'macOS Browser';
  }
  if (ua.includes('Windows')) {
    if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome Windows';
    if (ua.includes('Edg')) return 'Edge Windows';
    if (ua.includes('Firefox')) return 'Firefox Windows';
    return 'Windows Browser';
  }
  if (ua.includes('Linux')) {
    if (ua.includes('Chrome')) return 'Chrome Linux';
    if (ua.includes('Firefox')) return 'Firefox Linux';
    return 'Linux Browser';
  }
  return 'Unknown browser';
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'Z');
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

/** Convert base64url VAPID public key to Uint8Array for PushManager.subscribe() */
function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray.buffer;
}

export default function NotificationSection() {
  const [supported, setSupported] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [subscriptions, setSubscriptions] = useState<SubscriptionInfo[]>([]);
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);

  const fetchSubscriptions = useCallback(async () => {
    try {
      const res = await fetch('/api/push/subscriptions');
      if (res.ok) {
        const data = await res.json();
        setSubscriptions(data.subscriptions || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    async function checkStatus() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setSupported(false);
        setLoading(false);
        return;
      }

      // Check if notification permission was previously denied
      if ('Notification' in window && Notification.permission === 'denied') {
        setPermissionDenied(true);
      }

      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            setEnabled(true);
            setCurrentEndpoint(sub.endpoint);
          }
        }
      } catch { /* ignore */ }

      await fetchSubscriptions();
      setLoading(false);
    }
    checkStatus();
  }, [fetchSubscriptions]);

  const handleToggle = async () => {
    if (toggling) return;
    setToggling(true);

    try {
      if (enabled) {
        // Unsubscribe
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            await fetch('/api/push/subscribe', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ endpoint: sub.endpoint }),
            });
            await sub.unsubscribe();
          }
        }
        setEnabled(false);
        setCurrentEndpoint(null);
      } else {
        // Subscribe
        // Step 1: Request notification permission first
        if ('Notification' in window) {
          const permission = await Notification.requestPermission();
          if (permission === 'denied') {
            alert('Notification permission is blocked. Please enable it in your browser settings for this site.');
            setToggling(false);
            return;
          }
          if (permission !== 'granted') {
            setToggling(false);
            return;
          }
        }

        // Step 2: Get VAPID key and register SW
        const vapidRes = await fetch('/api/push/vapid-public-key');
        if (!vapidRes.ok) throw new Error('Failed to get VAPID key');
        const { publicKey } = await vapidRes.json();

        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        const subJson = sub.toJSON();
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: { p256dh: subJson.keys?.p256dh, auth: subJson.keys?.auth },
            userAgent: navigator.userAgent,
          }),
        });

        setEnabled(true);
        setCurrentEndpoint(sub.endpoint);
      }
      await fetchSubscriptions();
    } catch (error) {
      console.error('Push toggle failed:', error);
      alert('Failed to toggle push notifications. Check browser permissions.');
    } finally {
      setToggling(false);
    }
  };

  const handleRemoveDevice = async (endpoint: string) => {
    try {
      await fetch('/api/push/subscribe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });

      if (endpoint === currentEndpoint) {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) await sub.unsubscribe();
        }
        setEnabled(false);
        setCurrentEndpoint(null);
      }

      await fetchSubscriptions();
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Push Notifications</h2>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Push Notifications</h2>
      <p className="text-sm text-muted-foreground">
        Receive notifications when tasks complete or need your approval, even when the browser is in the background.
      </p>

      {!supported ? (
        <p className="text-sm text-orange-500">
          Push notifications are not supported in this browser. Try using Chrome or Safari over HTTPS.
        </p>
      ) : permissionDenied && !enabled ? (
        <p className="text-sm text-orange-500">
          Notification permission is blocked. Please enable it in your browser site settings, then reload the page.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <button
              onClick={handleToggle}
              disabled={toggling}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
              } ${toggling ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="text-sm">
              {toggling ? 'Processing...' : enabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          {subscriptions.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">Subscribed devices:</h3>
              {subscriptions.map((sub) => (
                <div key={sub.endpoint} className="flex items-center justify-between text-sm py-1">
                  <span>
                    {parseUserAgent(sub.userAgent)}
                    {sub.endpoint === currentEndpoint && (
                      <span className="ml-2 text-xs text-muted-foreground">(this device)</span>
                    )}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatDate(sub.createdAt)}
                    </span>
                  </span>
                  <button
                    onClick={() => handleRemoveDevice(sub.endpoint)}
                    className="text-xs text-red-500 hover:text-red-700 px-2 py-0.5"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
