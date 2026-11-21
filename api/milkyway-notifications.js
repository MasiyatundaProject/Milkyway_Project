import { route, ApiError, eq, isMissingSchema } from './_lib/supa.js';

const ROOM = /^mw-[a-zA-Z0-9_-]{3,120}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const publicKey = () => (process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '').trim();

function mustUse(method, allowed) {
  if (!allowed.includes(method)) throw new ApiError(405, 'Method not allowed.');
}

const isMissingColumn = (error, column) => isMissingSchema(error)
  && new RegExp(`\\b${column}\\b`, 'i').test(String(error?.message || ''));
const PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 10000;
async function pages(ctx, path) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const batch = await ctx.rest(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    rows.push(...(batch || []));
    if ((batch || []).length < PAGE_SIZE) return rows;
    if (offset + PAGE_SIZE >= MAX_PAGE_SIZE) {
      const overflow = await ctx.rest(`${path}&limit=1&offset=${MAX_PAGE_SIZE}`);
      if (overflow?.length) throw new ApiError(503, 'Too many unread items to load. Please open your inbox to clear some notifications.');
      return rows;
    }
  }
}

async function loadLiveAlerts(ctx) {
  const base = `mw_live_alerts?recipient_id=${eq(ctx.user.id)}&`;
  try {
    return await ctx.rest(`${base}select=room_name,host_id,host_name,title,created_at,read_at&order=created_at.desc&limit=100`);
  } catch (error) {
    if (!isMissingColumn(error, 'room_name')) throw error;
    const rows = await ctx.rest(`${base}select=room,host_id,host_name,title,created_at,read_at&order=created_at.desc&limit=100`);
    return (rows || []).map(row => ({ ...row, room_name: row.room }));
  }
}

async function loadUnreadMessages(ctx) {
  const rows = await pages(ctx, `mw_messages?select=id,sender_id,created_at&receiver_id=${eq(ctx.user.id)}&read_at=is.null&order=created_at.asc,id.asc`);
  const counts = new Map();
  for (const row of rows) {
    const item = counts.get(row.sender_id) || { count: 0, createdAt: row.created_at };
    item.count += 1;
    if (Date.parse(row.created_at) > Date.parse(item.createdAt)) item.createdAt = row.created_at;
    counts.set(row.sender_id, item);
  }
  const names = new Map();
  if (counts.size) {
    const ids = [...counts.keys()].map(id => encodeURIComponent(id)).join(',');
    const profiles = await ctx.rest(`mw_profiles?select=id,display_name,username&id=in.(${ids})&limit=${counts.size}`);
    for (const profile of profiles || []) names.set(profile.id, profile.display_name || profile.username || 'MilkyWay');
  }
  return [...counts].map(([peerId, item]) => ({
    type: 'message', peerId, title: names.get(peerId) || 'MilkyWay',
    count: item.count, createdAt: item.createdAt, read: false,
  }));
}

async function loadUnreadGroupMessages(ctx) {
  const members = await ctx.rest(`mw_dm_group_members?select=group_id,role,join_status,joined_at,last_read_at,mw_dm_groups(name)&user_id=${eq(ctx.user.id)}&limit=500`);
  const active = (members || []).filter(member => ['active', 'approved'].includes(String(member.join_status || '').toLowerCase())
    || ['admin', 'co_admin', 'owner'].includes(String(member.role || '').toLowerCase()));
  if (!active.length) return [];
  const groupMap = new Map(active.map(member => [member.group_id, {
    name: member.mw_dm_groups?.name || 'Group chat',
    since: member.last_read_at || member.joined_at || '1970-01-01T00:00:00.000Z',
  }]));
  const groupIds = [...groupMap.keys()];
  const oldest = [...groupMap.values()].reduce((value, item) => Date.parse(item.since) < Date.parse(value) ? item.since : value, '9999-12-31T23:59:59.999Z');
  const ids = groupIds.map(id => encodeURIComponent(id)).join(',');
  const rows = await pages(ctx, `mw_dm_group_messages?select=id,group_id,created_at&group_id=in.(${ids})&sender_id=neq.${encodeURIComponent(ctx.user.id)}&created_at=gt.${encodeURIComponent(oldest)}&order=created_at.asc,id.asc`);
  const counts = new Map();
  for (const row of rows) {
    const group = groupMap.get(row.group_id);
    if (!group || Date.parse(row.created_at) <= Date.parse(group.since)) continue;
    const item = counts.get(row.group_id) || { count: 0, createdAt: row.created_at };
    item.count += 1;
    if (Date.parse(row.created_at) > Date.parse(item.createdAt)) item.createdAt = row.created_at;
    counts.set(row.group_id, item);
  }
  return [...counts].map(([groupId, item]) => ({
    type: 'group', groupId, title: groupMap.get(groupId).name,
    count: item.count, createdAt: item.createdAt, read: false,
  }));
}

async function loadCallAlerts(ctx) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const [ringing, missed] = await Promise.all([
    ctx.rest(`mw_dm_calls?callee_id=${eq(ctx.user.id)}&status=eq.ringing&created_at=gte.${encodeURIComponent(since)}&select=id,caller_id,status,answer,created_at,ended_at&order=created_at.asc,id.asc&limit=100`),
    pages(ctx, `mw_dm_calls?callee_id=${eq(ctx.user.id)}&status=eq.ended&answer->>outcome=eq.missed&select=id,caller_id,status,answer,created_at,ended_at&order=created_at.asc,id.asc`),
  ]);
  const rows = [...(ringing || []), ...missed];
  const unread = rows.filter(call => {
    const isRinging = call.status === 'ringing';
    const missed = call.status === 'ended' && call.answer?.outcome === 'missed';
    const readBy = Array.isArray(call.answer?.notification_read_by) ? call.answer.notification_read_by : [];
    return (isRinging || missed) && !readBy.includes(ctx.user.id);
  });
  const callerIds = [...new Set(unread.map(call => call.caller_id))];
  const names = new Map();
  if (callerIds.length) {
    const ids = callerIds.map(id => encodeURIComponent(id)).join(',');
    const profiles = await ctx.rest(`mw_profiles?select=id,display_name,username&id=in.(${ids})&limit=${callerIds.length}`);
    for (const profile of profiles || []) names.set(profile.id, profile.display_name || profile.username || 'MilkyWay');
  }
  return unread.map(call => ({
    type: 'call', callId: call.id, callerId: call.caller_id,
    title: names.get(call.caller_id) || 'MilkyWay',
    status: call.status === 'ringing' ? 'incoming' : 'missed',
    createdAt: call.created_at, read: false,
  }));
}

async function loadPreferences(ctx) {
  const [row] = await ctx.rest(`mw_notification_preferences?user_id=${eq(ctx.user.id)}&select=live_enabled,sound_enabled,language&limit=1`) || [];
  return { liveEnabled: row ? row.live_enabled !== false : true, soundEnabled: row ? row.sound_enabled !== false : true, language: row?.language || 'en' };
}

export default route({
  alerts: async ({ ctx, method }) => {
    mustUse(method, ['GET']);
    const [liveRows, postRows, messages, groups, calls] = await Promise.all([
      loadLiveAlerts(ctx),
      ctx.rest(`mw_post_notifications?recipient_id=${eq(ctx.user.id)}&select=id,actor_id,actor_name,post_id,caption,created_at,read_at&order=created_at.desc&limit=100`),
      loadUnreadMessages(ctx),
      loadUnreadGroupMessages(ctx),
      loadCallAlerts(ctx),
    ]);
    const liveAlerts = (liveRows || []).map(row => ({
      type: 'live', room: row.room_name || row.room, hostId: row.host_id,
      hostName: row.host_name || '', title: row.title || '',
      createdAt: row.created_at, read: !!row.read_at,
    }));
    const postAlerts = (postRows || []).map(row => ({
      type: 'post', notificationId: row.id, actorId: row.actor_id,
      postId: row.post_id, title: row.actor_name || 'MilkyWay',
      caption: row.caption || '', createdAt: row.created_at, read: !!row.read_at,
    }));
    const alerts = [...liveAlerts, ...postAlerts, ...messages, ...groups, ...calls]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const unread = alerts.filter(alert => !alert.read).length;
    const dmUnread = {
      messages: messages.reduce((total, alert) => total + alert.count, 0),
      groups: groups.reduce((total, alert) => total + alert.count, 0),
      calls: calls.length,
    };
    return { alerts, unread, dmUnread: { ...dmUnread, total: dmUnread.messages + dmUnread.groups + dmUnread.calls } };
  },

  read: async ({ ctx, body, method }) => {
    mustUse(method, ['POST']);
    const at = new Date().toISOString();
    const rooms = Array.isArray(body.rooms) ? [...new Set(body.rooms.filter(room => typeof room === 'string' && ROOM.test(room)))].slice(0, 100) : [];
    const postIds = Array.isArray(body.postIds) ? [...new Set(body.postIds.filter(id => /^[a-f0-9-]{36}$/i.test(id)))].slice(0, 100) : [];
    const callIds = Array.isArray(body.callIds) ? [...new Set(body.callIds.filter(id => /^[a-f0-9-]{36}$/i.test(id)))].slice(0, 100) : [];
    if (!rooms.length && !postIds.length && !callIds.length) throw new ApiError(400, 'No notifications to mark as read.');
    if (rooms.length) {
      const list = rooms.map(room => encodeURIComponent(room)).join(',');
      try {
        await ctx.rest(`mw_live_alerts?recipient_id=${eq(ctx.user.id)}&room_name=in.(${list})&read_at=is.null`, { method: 'PATCH', body: { read_at: at } });
      } catch (error) {
        if (!isMissingColumn(error, 'room_name')) throw error;
        await ctx.rest(`mw_live_alerts?recipient_id=${eq(ctx.user.id)}&room=in.(${list})&read_at=is.null`, { method: 'PATCH', body: { read_at: at } });
      }
    }
    if (postIds.length) {
      const list = postIds.map(id => encodeURIComponent(id)).join(',');
      await ctx.rest(`mw_post_notifications?recipient_id=${eq(ctx.user.id)}&id=in.(${list})&read_at=is.null`, { method: 'PATCH', body: { read_at: at } });
    }
    for (const id of callIds) await ctx.rpc('mw_dm_call_notification_read', { p_call: id });
    return { ok: true };
  },

  preferences: async ({ ctx, body, method }) => {
    mustUse(method, ['POST']);
    if (typeof body.liveEnabled !== 'boolean') throw new ApiError(400, 'Invalid preferences.');
    const row = {
      user_id: ctx.user.id,
      live_enabled: body.liveEnabled,
      sound_enabled: body.soundEnabled !== false,
      language: typeof body.language === 'string' && LANGUAGE.test(body.language) ? body.language : 'en',
      updated_at: new Date().toISOString(),
    };
    await ctx.rest('mw_notification_preferences?on_conflict=user_id', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates' });
    return { ok: true, preferences: { liveEnabled: row.live_enabled, soundEnabled: row.sound_enabled, language: row.language } };
  },

  settings: async ({ ctx, method }) => {
    mustUse(method, ['GET']);
    const key = publicKey();
    return { preferences: await loadPreferences(ctx), pushAvailable: !!key, ...(key ? { publicKey: key } : {}) };
  },

  subscription: async ({ ctx, body, method }) => {
    mustUse(method, ['POST', 'DELETE']);
    const subscription = body.subscription;
    const endpoint = subscription?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || !/^https:\/\/[^\s]+$/.test(endpoint)) throw new ApiError(400, 'Invalid push subscription.');
    if (method === 'DELETE') {
      await ctx.rest(`mw_push_subscriptions?user_id=${eq(ctx.user.id)}&endpoint=${eq(endpoint)}`, { method: 'DELETE' });
      return { ok: true };
    }
    const { p256dh, auth } = subscription.keys || {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth || p256dh.length > 256 || auth.length > 256) throw new ApiError(400, 'Invalid push subscription.');
    await ctx.rpc('mw_push_subscription_register', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth });
    return { ok: true };
  },

  'live-started': async ({ ctx, body, method }) => {
    mustUse(method, ['POST']);
    if (typeof body.room !== 'string' || !ROOM.test(body.room)) throw new ApiError(400, 'Invalid room.');
    const result = await ctx.rpc('mw_live_announce', { p_room: body.room });
    return { complete: result?.complete === true, notified: Number(result?.notified) || 0 };
  },
});
