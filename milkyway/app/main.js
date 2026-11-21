// MilkyWay app entry.
//
// Startup budget (what happens before the first frame of content):
//   1. index.html paints the shell (static HTML + one CSS file) — no blocking scripts, no network.
//   2. This module reads the session from localStorage (sync) and the feed from IndexedDB (~10–30 ms).
//   3. The cached feed renders; video #1 starts. Network refresh, supabase-js, LiveKit and every sheet load later,
//      in the background or on first use.
import { config } from './config.js';
import { auth, supabase } from './core/net.js';
import { bus, idle } from './core/events.js';
import { t } from './core/i18n.js';
import { FeedView } from './ui/feed-view.js';
import { playback } from './ui/playback.js';
import { toast } from './ui/dom.js';
import { profiles } from './data/profiles.js';
import { fetchSharedPost } from './data/feed.js';
import { startUpdateCheck } from './core/update-check.js';
import { initPushNotifications } from './core/push.js';

// Conversation-room links belong to a screen that is not in this shell yet. Call links (#call=<id>) open the call screen.
const comingSoon = hash => /^#live=mw-conversation-/.test(hash);
const callLink = hash => /^#call=([a-f0-9-]{36})/i.exec(hash)?.[1] || null;
const soon = () => toast(t('soon'));

const $ = id => document.getElementById(id);
const shell = document.documentElement;

// ---- Lazily created panels (code downloads on first use) -------------------------------------------------
const lazy = loader => { let value; const get = () => (value ||= loader()); get.loaded = () => Boolean(value); return get; };
const authSheet = lazy(() => import('./ui/auth-sheet.js').then(m => new m.AuthSheet()));
const commentsSheet = lazy(() => import('./ui/comments-sheet.js').then(m => new m.CommentsSheet({ requireLogin })));
const giftTray = lazy(() => import('./ui/gift-tray.js').then(m => new m.GiftTray({
  onTopUp: () => novaMenu().then(menu => menu.openWallet()),
})));
const inboxView = lazy(() => import('./ui/inbox-view.js').then(m => new m.InboxView()));
const notificationsView = lazy(() => import('./ui/notifications-view.js').then(m => new m.NotificationsView({
  onOpenLive: room => showLive(room),
  onOpenMessage: peerId => openDirectMessage(peerId),
})));
const walkieTalkieView = lazy(() => import('./ui/walkie-talkie.js').then(m => new m.WalkieTalkieView()));
const callView = lazy(() => import('./ui/call-view.js').then(m => m.calls));
const novaMenu = lazy(() => import('./ui/settings-view.js').then(m => new m.NovaMenu({
  openProfilePhoto: file => {
    if (!requireLogin()) return;
    profileView().then(view => view.openForPhoto(file)).catch(error => toast(error?.message || t('photoUploadFailed')));
  },
  openStudioPost: post => {
    if (!post) { openCreate(); return; }
    postViewer().then(viewer => viewer.open([post], 0, { own: true }));
  },
})));
const profileView = lazy(() => import('./ui/profile-view.js').then(m => new m.ProfileView({
  requireLogin, openCreate, openComments: (post, onCommentAdded) => commentsSheet().then(sheet => sheet.open(post, onCommentAdded)),
  openMenu: profile => novaMenu().then(menu => menu.open(profile)),
  openChat: person => { if (requireLogin()) inboxView().then(view => view.openWith(person)); },
})));
const profileSearch = lazy(() => import('./ui/profile-search.js').then(m => new m.ProfileSearch({ openProfile })));
const composeSheet = lazy(() => import('./ui/compose-sheet.js').then(m => new m.ComposeSheet()));
// Full-size post popup for photos tapped in the Orbit feed (the same viewer the Nova grid uses).
const postViewer = lazy(() => import('./ui/post-viewer.js').then(m => new m.PostViewer({
  requireLogin,
  openComments: (post, onCommentAdded) => commentsSheet().then(sheet => sheet.open(post, onCommentAdded)),
})));
function openPost(post) {
  if (!post) return;
  playback.suspend(true);
  postViewer().then(viewer => {
    // Keep an independent object so the modal's metric refresh cannot move the feed card.
    viewer.open([{ ...post }], 0, { own: false, onClose: () => { if (shell.dataset.view === 'home') playback.suspend(false); } });
  }).catch(() => { playback.suspend(shell.dataset.view !== 'home'); toast(t('imageUnavailable')); });
}
const discoveryView = lazy(() => import('./ui/discovery-view.js').then(m => new m.DiscoveryView($('exploreView'), { openProfile, openPost })));
const liveView = lazy(() => import('./ui/live-view.js').then(m => new m.LiveView($('liveView'), {
  requireLogin, openProfile, onClose: () => showHome(),
  openGifts: target => giftTray().then(tray => tray.open(target)),
})));

function requireLogin() {
  if (auth.signedIn()) return true;
  authSheet().then(sheet => sheet.open());
  return false;
}
// Any author (feed / Lives) or, with no argument, the signed-in user's own profile.
function openProfile(person = null) {
  if (!person?.id && !requireLogin()) return;
  profileView().then(view => view.open(person?.id ? person : null));
}
function openCreate() {
  if (requireLogin()) composeSheet().then(sheet => sheet.open());
}

// ---- Feed ---------------------------------------------------------------------------------------------------
const feedView = new FeedView($('feedView'), {
  requireLogin,
  openProfile,
  openComments: post => commentsSheet().then(sheet => sheet.open(post)),
  openGifts: target => giftTray().then(tray => tray.open(target)),
  openPost,
});

let scope = auth.signedIn() && localStorage.getItem('mw_core_scope') === 'following' ? 'following' : 'foryou';
function setScope(next) {
  if (next === 'following' && !requireLogin()) return;
  scope = next;
  try { localStorage.setItem('mw_core_scope', next); } catch {}
  document.querySelectorAll('[data-scope]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.scope === next)));
  feedView.show(next);
}

// ---- Views ------------------------------------------------------------------------------------------------
function setNav(name) {
  document.querySelectorAll('.nav-btn').forEach(button => button.toggleAttribute('aria-current', button.dataset.nav === name));
  shell.dataset.view = name;
}
function showHome() {
  if (liveView.loaded()) liveView().then(view => view.close());
  $('liveView').hidden = true;
  $('exploreView').hidden = true;
  $('feedView').hidden = false;
  playback.suspend(false);
  setNav('home');
  if (location.hash.startsWith('#live')) history.replaceState(null, '', location.pathname);
  feedView.focus();
}
function showLive(room = null) {
  if (!requireLogin()) return;
  playback.suspend(true);
  $('feedView').hidden = true;
  $('exploreView').hidden = true;
  $('liveView').hidden = false;
  setNav('live');
  if (!location.hash.startsWith('#live')) history.pushState({ live: true }, '', room ? `#live=${encodeURIComponent(room)}` : '#live');
  liveView().then(view => view.open(room));
}
function showExplore() {
  if (liveView.loaded()) liveView().then(view => view.close());
  if (location.hash.startsWith('#live')) history.replaceState(null, '', location.pathname + location.search);
  $('feedView').hidden = true;
  $('liveView').hidden = true;
  $('exploreView').hidden = false;
  playback.suspend(true);
  setNav('explore');
  discoveryView().then(view => view.open()).catch(error => {
    console.error('[explore] discovery view could not be opened', error);
    toast(t('exploreLoadFailed'));
  });
}

function route() {
  const call = callLink(location.hash);
  if (call) {
    const params = new URLSearchParams(location.search);
    const action = params.get('do') || '';
    params.delete('do');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
    if (requireLogin()) {
      if (action === 'missed') inboxView().then(view => view.open());
      else callView().then(calls => calls.handleNotification(call, action));
    }
  }
  if (comingSoon(location.hash)) { history.replaceState(null, '', location.pathname + location.search); soon(); }
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('live')) showLive(hash.split('=')[1] || null);
  else if (shell.dataset.view === 'live') showHome();
  openDirectMessageFromUrl(new URL(location.href));
}
addEventListener('popstate', route);

function openDirectMessageFromUrl(address) {
  const peerId = address.searchParams.get('dm');
  if (!peerId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(peerId)) return;
  if (!requireLogin()) return;
  if (address.href === location.href) {
    address.searchParams.delete('dm');
    history.replaceState(null, '', address.pathname + (address.search ? address.search : '') + address.hash);
  }
  openDirectMessage(peerId);
}

function openDirectMessage(peerId) {
  if (!requireLogin() || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(peerId)) return;
  profiles.many([peerId]).then(people => {
    const person = people.get(peerId) || { id: peerId, name: 'MilkyWay' };
    return inboxView().then(view => view.openWith(person));
  }).catch(error => {
    console.warn('[notifications] Could not open the linked conversation.', error);
    toast(error?.message || t('retry'));
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data?.type === 'mw-open-url' || data?.type === 'mw-open-live') {
      if (typeof data.url !== 'string') return;
      let address;
      try { address = new URL(data.url, location.href); } catch { return; }
      if (address.origin !== location.origin || address.pathname !== '/milkyway/') return;
      const postId = address.searchParams.get('post');
      if (postId) {
        fetchSharedPost(postId).then(openPost).catch(error => toast(error?.message || t('imageUnavailable')));
        return;
      }
      if (address.searchParams.has('dm')) {
        openDirectMessageFromUrl(address);
        return;
      }
      if (comingSoon(address.hash)) soon();
      else if (address.hash) { history.pushState(null, '', address.hash); route(); }
    } else if (data?.type === 'mw-call-push' || data?.type === 'mw-call-action') {
      let linkedCall = null;
      try { linkedCall = callLink(new URL(data.url || location.href, location.href).hash); } catch {}
      const id = data.callId || data.call?.id || data.id || linkedCall;
      if (auth.signedIn()) {
        if (data.action === 'missed') inboxView().then(view => view.open());
        else callView().then(calls => (id ? calls.handleNotification(String(id), data.action || '') : calls.watch()));
      }
    }
  });
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-scope], [data-nav], #liveEntry, #walkieEntry, #muteToggle, #profileSearch, #notificationsButton');
  if (!target) return;
  if (target.dataset.scope) { if (shell.dataset.view !== 'home') showHome(); setScope(target.dataset.scope); return; }
  if (target.id === 'liveEntry') { showLive(); return; }
  if (target.id === 'walkieEntry') {
    if (requireLogin()) walkieTalkieView().then(view => view.open()).catch(error => {
      console.error('[walkie-talkie] view could not be opened', error);
      toast(error?.message || t('recordingFailed'));
    });
    return;
  }
  if (target.id === 'muteToggle') { playback.setMuted(!playback.muted); return; }
  if (target.id === 'profileSearch') { profileSearch().then(view => view.open()); return; }
  if (target.id === 'notificationsButton') {
    if (requireLogin()) notificationsView().then(view => view.open()).catch(error => {
      console.error('[notifications] view could not be opened', error);
      toast(error?.message || t('notificationSetupFailed'));
    });
    return;
  }
  const nav = target.dataset.nav;
  if (nav === 'home') { if (shell.dataset.view === 'home') feedView.reload(); else showHome(); }
  else if (nav === 'explore') showExplore();
  else if (nav === 'create') openCreate();
  else if (nav === 'inbox') { if (requireLogin()) inboxView().then(view => view.open()); }
  else if (nav === 'me') openProfile();
});

// ---- Connectivity + account changes ----------------------------------------------------------------------
bus.on('offline', () => { $('netBanner').hidden = false; $('netBanner').textContent = t('offline'); });
bus.on('online', () => { if (!$('netBanner').hidden) { $('netBanner').hidden = true; toast(t('backOnline')); } });
if (navigator.onLine === false) { $('netBanner').hidden = false; $('netBanner').textContent = t('offline'); }
let syncingOAuthUsername = false;
async function syncPendingOAuthUsername() {
  const key = 'mw_pending_oauth_username';
  const raw = localStorage.getItem(key);
  if (!raw || !auth.signedIn() || syncingOAuthUsername) return;
  let pending;
  try { pending = JSON.parse(raw); }
  catch {
    localStorage.removeItem(key);
    return;
  }
  if (typeof pending?.username !== 'string' || !Number.isFinite(pending.startedAt)
    || Date.now() - pending.startedAt > 30 * 60 * 1000) {
    localStorage.removeItem(key);
    return;
  }
  const createdAt = Date.parse(auth.user?.created_at || '');
  if (!Number.isFinite(createdAt) || createdAt < pending.startedAt - 60_000) {
    localStorage.removeItem(key);
    return;
  }
  const userId = auth.userId;
  syncingOAuthUsername = true;
  try {
    const sb = await supabase();
    if (userId !== auth.userId) return;
    const { error } = await sb.from('mw_profiles').upsert(
      { id: userId, username: pending.username },
      { onConflict: 'id' },
    );
    if (error) throw error;
    if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
  } catch (error) {
    console.error('[auth] Google sign-up username could not be saved', error);
    toast(error.message || 'Your username could not be saved. Please try again.');
  } finally {
    syncingOAuthUsername = false;
  }
}
bus.on('auth', () => {
  shell.toggleAttribute('data-signed-in', auth.signedIn());
  if (!auth.signedIn() && scope === 'following') scope = 'foryou';
  feedView.scope = null;
  setScope(scope);
  if (auth.signedIn()) {
    syncPendingOAuthUsername();
    startSignedIn();
    openDirectMessageFromUrl(new URL(location.href));
  }
});
shell.toggleAttribute('data-signed-in', auth.signedIn());
playback.onMute(muted => shell.toggleAttribute('data-muted', muted));
shell.toggleAttribute('data-muted', playback.muted);

// ---- Go -----------------------------------------------------------------------------------------------------
document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
$('profileSearch').setAttribute('aria-label', t('searchPeople'));
$('profileSearch').title = t('searchPeople');
$('notificationsButton').setAttribute('aria-label', t('notifications'));
$('notificationsButton').title = t('notifications');
setScope(scope);
route();
const sharedPostId = new URLSearchParams(location.search).get('post');
if (sharedPostId) fetchSharedPost(sharedPostId).then(openPost).catch(error => toast(error?.message || t('imageUnavailable')));

// Signed-in extras, loaded when idle: incoming calls and online status.
let signedInStarted = false;
function startSignedIn() {
  if (signedInStarted || !auth.signedIn()) return;
  signedInStarted = true;
  callView().then(calls => calls.watch());
  import('./data/post-notifications.js').then(({ watchPostNotifications }) => watchPostNotifications())
    .catch(error => console.warn('[notifications] post realtime unavailable', error));
  import('./data/presence.js').then(({ presence }) => presence.start());
  notificationsView().then(view => {
    view.onUnread = count => {
      const badge = $('notificationUnread');
      if (!badge) return;
      badge.hidden = count < 1;
      badge.classList.toggle('has-count', count > 0);
      badge.textContent = count > 99 ? '99+' : count > 0 ? String(count) : '';
      $('notificationsButton')?.setAttribute('aria-label', `${t('notifications')}${count ? `, ${count} ${t('unread')}` : ''}`);
    };
    view.preload();
  }).catch(error => console.warn('[notifications] unread state could not be loaded', error));
  import('./data/messages.js').then(({ onMessage, isForegroundConversation }) => {
    onMessage(({ type, message }) => {
      if (type !== 'INSERT' || message?.receiver_id !== auth.userId || message.sender_id === auth.userId
        || isForegroundConversation(message.sender_id) || document.visibilityState !== 'visible') return;
      const sender = profiles.peek(message.sender_id)?.name || 'MilkyWay';
      toast(`${sender} ${t('sentYouMessage')}`);
      import('./core/notification-sound.js').then(({ playMessageAlert }) => playMessageAlert())
        .catch(error => console.warn('[notifications] message sound could not be played', error));
    });
  }).catch(error => console.warn('[notifications] DM realtime listener could not be started', error));
}

idle(() => {
  syncPendingOAuthUsername();
  profiles.loadFollowing();
  startSignedIn();
  // LIVE badge: show when someone is live (cached list first, quiet refresh).
  import('./data/live.js').then(({ lives }) => {
    lives.subscribe(list => $('liveEntry')?.classList.toggle('has-live', (list?.length || 0) > 0));
    lives.load();
  });
  startUpdateCheck(config.deploymentId);
  initPushNotifications();
}, 2500);
