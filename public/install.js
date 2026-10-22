// Install support: registers the service worker and offers "install this app" help where the browser needs it.
// iPhone has no install prompt, so a card explains Share, then Add to Home Screen. Chrome on Android offers its own
// prompt, which the card triggers. Nothing here changes data; the installed app is read-only (see styles.css).

// Works out the platform from the user agent. Pure, so it can be tested.
function detectPlatform(ua, { standalone = false, platform = '', maxTouchPoints = 0 } = {}) {
  const iPadOnDesktopUA = platform === 'MacIntel' && maxTouchPoints > 1; // iPadOS reports itself as a Mac
  const ios = /iPhone|iPad|iPod/.test(ua) || iPadOnDesktopUA;
  const android = /Android/.test(ua);
  const v = ios ? /OS (\d+)[_.](\d+)/.exec(ua) : null;
  return {
    os: ios ? 'ios' : android ? 'android' : 'other',
    standalone: Boolean(standalone),
    iosVersion: v ? [Number(v[1]), Number(v[2])] : null,
  };
}

// Web push (planned) needs iOS 16.4 or newer; unknown versions are given the benefit of the doubt.
function iosSupportsPush(iosVersion) {
  if (!iosVersion) return true;
  const [major, minor] = iosVersion;
  return major > 16 || (major === 16 && minor >= 4);
}

(typeof window !== 'undefined' ? window : globalThis).installHelpers = { detectPlatform, iosSupportsPush };

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const info = detectPlatform(navigator.userAgent, { standalone, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints });
  if (standalone) document.documentElement.classList.add('standalone'); // the installed app is read-only

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* not a secure context, or blocked */ });

  let dismissed = false;
  try { dismissed = localStorage.getItem('installDismissed') === '1'; } catch { /* storage unavailable */ }
  const card = $('install');
  const hide = () => { card.hidden = true; try { localStorage.setItem('installDismissed', '1'); } catch { /* ignore */ } };
  $('install-dismiss').addEventListener('click', hide);

  if (!standalone && !dismissed) {
    if (info.os === 'ios') {
      $('install-ios').hidden = false;
      $('install-ios-old').hidden = iosSupportsPush(info.iosVersion);
      card.hidden = false;
    } else {
      window.addEventListener('beforeinstallprompt', (event) => { // Chrome and Edge: offer their own install prompt
        event.preventDefault();
        const button = $('install-button');
        button.hidden = false;
        button.addEventListener('click', async () => { event.prompt(); await event.userChoice; hide(); });
        card.hidden = false;
      });
    }
  }
  window.addEventListener('appinstalled', () => { card.hidden = true; });
}
