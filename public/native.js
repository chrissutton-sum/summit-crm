// Android app glue. Only does anything when running inside the Capacitor shell.
const Native = {
  cap: window.Capacitor,
  get on() { return !!this.cap?.isNativePlatform?.(); },
  get plugins() { return this.cap?.Plugins || {}; },

  start() {
    if (!this.on) return;
    document.documentElement.classList.add('native');
    const { App } = this.plugins;

    App?.addListener('backButton', () => {
      if (el('modal').style.display === 'block') return closeM();
      if (tab !== 'dash') { tab = 'dash'; render(); return; }
      App.minimizeApp();
    });
    App?.addListener('appStateChange', ({ isActive }) => {
      if (isActive) pullData(false);
    });
  },

  // Blob downloads (CSV/JSON backup) and anything meant to open outside the
  // app's WebView (Google Maps links, mailto: fallbacks, DocuSign) get
  // handed to the system browser instead of trying to navigate in place.
  openExternal(url) {
    const { Browser } = this.plugins;
    if (Browser) Browser.open({ url: new URL(url, location.href).href });
    else window.open(url, '_blank');
  },
};

document.addEventListener('click', e => {
  if (!Native.on) return;
  const a = e.target.closest('a[href]');
  if (!a) return;
  if (a.target === '_blank') {
    e.preventDefault();
    e.stopPropagation();
    Native.openExternal(a.getAttribute('href'));
  }
}, true);

// Point Android browser visitors at the app instead of the mobile web view.
if (/Android/i.test(navigator.userAgent) && !Native.on) {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('getAndroidApp');
    if (el) el.style.display = '';
  });
}
