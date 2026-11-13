// Android app glue. Only does anything when running inside the Capacitor shell.
const Native = {
  cap: window.Capacitor,
  get on() { return !!this.cap?.isNativePlatform?.(); },
  get plugins() { return this.cap?.Plugins || {}; },

  start() {
    if (!this.on) return;
    document.documentElement.classList.add('native');
    const { App, PushNotifications } = this.plugins;

    App?.addListener('backButton', () => {
      if (el('modal').style.display === 'block') return closeM();
      if (tab !== 'dash') { tab = 'dash'; render(); return; }
      App.minimizeApp();
    });
    App?.addListener('appStateChange', ({ isActive }) => {
      if (isActive) pullData(false);
    });

    this.setupPush(PushNotifications);
  },

  // Push notifications: a new lead assigned to you, a deal you own moving
  // to Won, or tasks due today. The plugin hands us a device token once
  // registered; we just forward it to the server (api()/TOKEN are globals
  // from the main script, already loaded by the time start() runs) so it
  // knows where to send those. Quietly does nothing if the plugin is
  // missing or the permission prompt is declined — no server call either way.
  setupPush(PushNotifications) {
    if (!PushNotifications) return;
    PushNotifications.addListener('registration', token => {
      this._pushToken = token.value;
      api('/api/push/register', { method: 'POST', body: JSON.stringify({ token: token.value, platform: 'android' }) }).catch(() => {});
    });
    PushNotifications.addListener('registrationError', err => console.error('Push registration failed', err));
    // Tapping a notification just brings the relevant tab forward.
    PushNotifications.addListener('pushNotificationActionPerformed', n => {
      const type = n.notification?.data?.type;
      if (type === 'lead') tab = 'leads';
      else if (type === 'deal') tab = 'deals';
      else if (type === 'tasks') tab = 'tasks';
      render();
    });
    PushNotifications.checkPermissions()
      .then(p => p.receive === 'granted' ? p : p.receive === 'prompt' ? PushNotifications.requestPermissions() : p)
      .then(p => { if (p.receive === 'granted') PushNotifications.register(); })
      .catch(e => console.error('Push permission check failed', e));
  },

  // Blob downloads (CSV/JSON backup) and anything meant to open outside the
  // app's WebView (Google Maps links, mailto: fallbacks, DocuSign) get
  // handed to the system browser instead of trying to navigate in place.
  openExternal(url) {
    const { Browser } = this.plugins;
    if (Browser) Browser.open({ url: new URL(url, location.href).href });
    else window.open(url, '_blank');
  },

  // Called from doLogout() before the auth token is cleared, so the signed-
  // out device stops getting this account's notifications (otherwise a
  // shared/handed-down phone would keep alerting whoever's logged out).
  unregisterPush() {
    if (!this.on || !this._pushToken) return;
    api('/api/push/unregister', { method: 'POST', body: JSON.stringify({ token: this._pushToken }) }).catch(() => {});
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
