// DM audio/video/image storage plus the authenticated one-view stream endpoint.
import { config } from '../config.js';
import { accessToken, api, auth, supabase } from '../core/net.js';
import { identifyMediaFile } from '../core/media-files.js';

const extension = name => String(name || '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';

export async function uploadChatMedia(file, { id, viewOnce = false } = {}) {
  if (!auth.userId || !file || !id) throw new Error('Sign in and select a media file first.');
  const info = await identifyMediaFile(file);
  if (!['image', 'video', 'audio'].includes(info.kind) || !info.type) throw new Error('Choose a supported image, video or audio file.');
  const safeName = String(file.name || `${info.kind}.${info.extension}`).replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80);
  const bucket = viewOnce ? 'mw-dm-ephemeral' : 'portfolio';
  const path = viewOnce
    ? `${auth.userId}/${id}.${extension(info.extension || safeName)}`
    : `milkyway/${auth.userId}/dm/${id}-${safeName}`;
  const client = await supabase();
  const result = await client.storage.from(bucket).upload(path, file, {
    contentType: info.type, cacheControl: viewOnce ? '0' : '3600', upsert: false,
  });
  if (result.error) throw new Error(result.error.message || 'Media upload failed.');
  const url = viewOnce ? '' : client.storage.from(bucket).getPublicUrl(path)?.data?.publicUrl;
  if (!viewOnce && !url) {
    await client.storage.from(bucket).remove([path]).catch(error => console.warn('[dm-media] failed to remove unlinked upload', error));
    throw new Error('Media storage did not return a URL.');
  }
  return { id, bucket, path, url: url || '', mediaType: info.type, messageType: info.kind };
}

export async function removeChatMedia(media) {
  if (!media?.bucket || !media?.path) return;
  const client = await supabase();
  const result = await client.storage.from(media.bucket).remove([media.path]);
  if (result.error) throw new Error(result.error.message || 'Could not remove the uploaded media.');
}

export async function sendViewOnce(options) {
  const data = await api(`${config.api.message}?action=send-once`, { method: 'POST', body: options, timeout: 20000 });
  return data?.message;
}

export async function consumeViewOnce(id, group = '') {
  const token = await accessToken();
  if (!token) throw new Error('Sign in first.');
  const response = await fetch(config.api.message + '?action=consume-once', {
    method: 'POST',
    headers: {
      Accept: 'application/json, image/*, video/*, audio/*',
      'Content-Type': 'application/json',
      apikey: config.supabase.anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ id, group: group || '' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || 'This view-once message is no longer available.');
  }
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    const data = await response.json();
    return { body: String(data?.body || ''), mediaType: '', metadata: {} };
  }
  const blob = await response.blob();
  return {
    blob,
    mediaType: response.headers.get('content-type') || blob.type || 'application/octet-stream',
    metadata: {},
  };
}
