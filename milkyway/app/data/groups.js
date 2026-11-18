// Group chat API and Realtime delivery, kept separate from direct-message threads.
import { config } from '../config.js';
import { api, auth, supabase } from '../core/net.js';
import { bus } from '../core/events.js';
import { removeChatMedia, sendViewOnce, uploadChatMedia } from './chat-media.js';

const endpoint = config.api.groups;
const listeners = new Set();
let channel = null;

const request = (action, options = {}, query = '') => api(`${endpoint}?action=${encodeURIComponent(action)}${query}`, options);

export async function loadGroups() {
  const data = await request('list', { timeout: 12000 });
  return data?.groups || [];
}

export async function discoverGroups(query = '') {
  const suffix = query ? `&q=${encodeURIComponent(query)}` : '';
  const data = await api(`${endpoint}?action=discover${suffix}`, { timeout: 12000 });
  return data?.groups || [];
}

export async function loadGroup(id) {
  return request('group', { timeout: 12000 }, `&id=${encodeURIComponent(id)}`);
}

export async function createGroup(options) {
  return request('create', { method: 'POST', body: options });
}

export async function updateGroup(options) {
  return request('update', { method: 'POST', body: options });
}

export async function addGroupMembers(group, userIds) {
  return request('add-member', { method: 'POST', body: { group, userIds } });
}

export async function setGroupRole(group, userId, role) {
  return request('set-role', { method: 'POST', body: { group, userId, role } });
}

export async function removeGroupMember(group, userId, block = false) {
  return request('remove-member', { method: 'POST', body: { group, userId, block } });
}

export async function decideGroupRequest(group, userId, approve) {
  return request('decide-request', { method: 'POST', body: { group, userId, approve } });
}

export async function joinGroup(group) {
  return request('join', { method: 'POST', body: { group } });
}

export async function leaveGroup(group) {
  return request('leave', { method: 'POST', body: { group } });
}

export async function loadGroupMessages(group) {
  const data = await request('messages', { timeout: 12000 }, `&group=${encodeURIComponent(group)}`);
  return (data?.messages || []).slice().reverse();
}

export async function sendGroupMessage(group, body, options = {}) {
  return request('send', { method: 'POST', body: { group, body, ...options } });
}

export async function sendGroupOneViewText(group, body) {
  const text = String(body || '').trim().slice(0, 4000);
  if (!text) throw new Error('Empty message');
  return sendViewOnce({ id: crypto.randomUUID(), group, messageType: 'text', body: text });
}

export async function sendGroupMedia(group, { file, noteType = '', viewOnce = false, peaks = [] } = {}) {
  const id = crypto.randomUUID();
  const uploaded = await uploadChatMedia(file, { id, viewOnce });
  const messageType = noteType || uploaded.messageType;
  const labels = { image: 'Photo', video: 'Video', audio: 'Audio', voice_note: 'Voice note', video_note: 'Video note' };
  const metadata = noteType === 'voice_note' ? { waveform: peaks.slice(0, 120) } : {};
  try {
    if (viewOnce) {
      return await sendViewOnce({
        id, group, messageType, body: '',
        bucket: uploaded.bucket, path: uploaded.path, mediaType: uploaded.mediaType, metadata,
      });
    }
    return await request('send', {
      method: 'POST',
      body: {
        group, id, body: labels[messageType] || labels[uploaded.messageType],
        messageType, mediaUrl: uploaded.url, mediaType: uploaded.mediaType, metadata,
      },
    });
  } catch (error) {
    await removeChatMedia(uploaded).catch(cleanupError => console.warn('[dm-media] failed to remove unlinked upload', cleanupError));
    throw error;
  }
}

export function onGroupMessage(listener) {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}

async function connect() {
  if (channel || !auth.signedIn()) return;
  const me = auth.userId;
  try {
    const client = await supabase();
    if (channel || auth.userId !== me) return;
    channel = client.channel(`mw-dm-groups-${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mw_dm_group_messages' }, payload => {
        const message = payload.eventType === 'DELETE' ? payload.old : payload.new;
        listeners.forEach(listener => { try { listener({ type: payload.eventType, message }); } catch {} });
      })
      .subscribe();
  } catch { channel = null; }
}

bus.on('auth', async () => {
  const old = channel;
  channel = null;
  if (old) { try { (await supabase()).removeChannel(old); } catch {} }
  if (auth.signedIn() && listeners.size) connect();
});
