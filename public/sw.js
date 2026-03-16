// CodePilot Push Notification Service Worker

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }

  const { title, body, sessionId, url } = data;

  event.waitUntil(
    self.registration.showNotification(title || 'CodePilot', {
      body: body || '',
      tag: sessionId ? 'codepilot-' + sessionId : 'codepilot',
      renotify: true,
      data: { url: url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  var targetUrl = event.notification.data && event.notification.data.url || '/';
  var absoluteUrl = new URL(targetUrl, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      // Try to reuse an existing CodePilot tab
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.indexOf(self.location.origin) === 0) {
          client.focus();
          if ('navigate' in client) {
            client.navigate(absoluteUrl);
          } else {
            client.postMessage({ type: 'push-navigate', url: targetUrl });
          }
          return;
        }
      }
      return clients.openWindow(absoluteUrl);
    })
  );
});
