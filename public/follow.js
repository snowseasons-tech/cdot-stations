// Following stations for push notifications. Runs after app.js and uses its helpers (getJson, SessionExpired,
// showNotice, el, $, and the `stations` list). The phone's push subscription is kept on the server together with the
// stations this device follows; the server sends a notification when a followed station's status or note changes.
(function () {
  // ---- pure helpers (tested) ----
  function urlBase64ToUint8Array(b64) {
    const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  const isFollowing = (current, id) => current.includes('all') || current.includes(id);
  // What the list becomes when the Follow button of one station is tapped. "all" is expanded into explicit ids when
  // one station is switched off.
  function nextFollowing(current, id, allIds) {
    if (current.includes('all')) return allIds.filter((x) => x !== id);
    return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  }
  const toggleAll = (current) => (current.includes('all') ? [] : ['all']);
  function sameBytes(a, b) {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  (typeof window !== 'undefined' ? window : globalThis).followHelpers = { urlBase64ToUint8Array, isFollowing, nextFollowing, toggleAll, sameBytes };

  if (typeof document === 'undefined') return;

  // ---- the feature ----
  const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return; // e.g. an iPhone browser tab (push needs the installed app) or the plain-HTTP LAN address

  let key = null;       // the server's public push key
  let following = [];   // station ids this device follows, or ['all']
  let busy = false;
  let ready = false;    // set once the server has confirmed push is on; until then no Follow buttons are drawn
  let problem = '';
  const blocked = () => Notification.permission === 'denied';

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.type === 'opaqueredirect') throw new SessionExpired();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? String(res.status));
    return data;
  }

  const nonPlanned = () => stations.filter((s) => !s.planned);

  function refreshPanel() {
    const names = following.includes('all') ? null : nonPlanned().filter((s) => following.includes(s.id)).map((s) => s.name);
    $('notify-all').checked = following.includes('all');
    $('notify-all').disabled = busy || blocked();
    $('notify-note').textContent = problem
      || (blocked() ? 'Notifications are blocked for this app. Turn them on in your phone\'s settings, then reload.'
        : busy ? 'Saving…'
        : following.includes('all') ? 'You will be notified when any station changes.'
        : names?.length ? `You will be notified when ${names.join(', ')} change${names.length === 1 ? 's' : ''}.`
        : 'Tap Follow on a station to be notified when its status or note changes.');
  }

  // Adds a Follow button to every station card. Called after each redraw of the list.
  function decorate() {
    if (!ready) return;
    for (const card of document.querySelectorAll('.card[data-station]')) {
      const id = card.dataset.station;
      let button = card.querySelector('.follow-btn');
      if (!button) {
        let actions = card.querySelector('.actions');
        if (!actions) { actions = el('div', { className: 'actions' }); card.append(actions); }
        button = el('button', { className: 'follow-btn', type: 'button' });
        button.addEventListener('click', (e) => { e.stopPropagation(); change(nextFollowing(following, id, nonPlanned().map((s) => s.id))); });
        actions.append(button);
      }
      const on = isFollowing(following, id);
      button.textContent = on ? 'Following' : 'Follow';
      button.setAttribute('aria-pressed', String(on));
      button.disabled = busy || blocked();
    }
  }

  // The permission prompt must be requested straight from the tap (iPhone refuses it after any waiting), so
  // change() and follow() run synchronously until Notification.requestPermission().
  async function follow(list) {
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (blocked()) return;
    const registration = await navigator.serviceWorker.ready;
    const keyBytes = urlBase64ToUint8Array(key);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && subscription.options?.applicationServerKey && !sameBytes(subscription.options.applicationServerKey, keyBytes)) {
      await subscription.unsubscribe(); // the server's key changed: this subscription can no longer be used
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
    following = (await post('/api/push/subscribe', { subscription: subscription.toJSON(), stations: list })).stations;
  }

  async function unfollowAll() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    following = [];
  }

  async function change(list) {
    if (busy) return;
    busy = true; problem = ''; refreshPanel(); decorate();
    try {
      await (list.length ? follow(list) : unfollowAll());
    } catch (error) {
      if (error instanceof SessionExpired) showNotice(error);
      else problem = 'Could not update notifications. Check your connection and try again.';
    } finally {
      busy = false; refreshPanel(); decorate();
    }
  }

  async function init() {
    try {
      key = (await getJson('/api/push/key')).publicKey; // 503 when the server has no keys: notifications stay hidden
    } catch (error) {
      if (error instanceof SessionExpired) showNotice(error);
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) following = (await post('/api/push/following', { endpoint: subscription.endpoint })).stations;
    } catch (error) {
      if (error instanceof SessionExpired) { showNotice(error); return; }
    }
    ready = true;
    $('notify').hidden = false;
    $('notify-all').addEventListener('change', () => change(toggleAll(following)));
    refreshPanel(); decorate();
  }

  window.followUi = { decorate };
  init();
})();
