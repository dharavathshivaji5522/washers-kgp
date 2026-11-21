self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  const data = event.data?.json();
  if (!data?.title) return;
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: "/washroom-192.png", tag: data.id, data: { url: data.url }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);
  if (url.origin === self.location.origin) event.waitUntil(self.clients.openWindow(url.href));
});
