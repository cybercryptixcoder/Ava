/* Ava service worker: web push with action buttons, and an offline app shell. */
const SHELL = "ava-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    // Network first for pages; fall back to the cached shell when offline.
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Ava", body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    data: { url: data.url || "/", card_id: data.card_id || null },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    renotify: false,
    actions: (data.actions || []).slice(0, 2),
  };
  event.waitUntil(self.registration.showNotification(data.title || "Ava", options));
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const { url, card_id } = n.data || {};
  n.close();
  const open = async (target) => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) {
        await c.focus();
        if ("navigate" in c) await c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  };
  if (card_id && (event.action === "yes" || event.action === "not_now")) {
    event.waitUntil(
      fetch(`/api/cards/${card_id}/respond`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: event.action }),
      })
        .then((r) => (r.ok ? null : open(url || "/")))
        .catch(() => open(url || "/")),
    );
    return;
  }
  event.waitUntil(open(url || "/"));
});
