import { route, ApiError, SUPABASE, requireUuid } from './_lib/supa.js';
import { livekitUrl, livekitUsable, livekitConfigured, accessToken, closeRoom, CAMERA, MIC } from './_lib/livekit.js';

const OUTCOMES = ['ended', 'missed', 'cancelled', 'rejected', 'disconnected'];
const RING_WINDOW_MS = 60000;
const COLUMNS = 'id,caller_id,callee_id,status,offer,answer,created_at,ended_at';
const POST_ONLY = method => { if (method !== 'POST') throw new ApiError(405, 'Method not allowed.'); };
const dmRoomName = call => `dm-call-${[call.caller_id, call.callee_id].map(id => id.toLowerCase()).sort().join('-')}`;

async function loadCall(ctx, id) {
  const [call] = await ctx.rest(`mw_dm_calls?id=eq.${requireUuid(id, 'call')}&select=${COLUMNS}&limit=1`) || [];
  if (!call) throw new ApiError(404, 'Call not found.');
  if (![call.caller_id, call.callee_id].includes(ctx.user.id)) throw new ApiError(403, 'Not allowed.');
  return call;
}

// Issues a participant-scoped token for the deterministic room shared by the two call participants.
async function access(ctx, call, name) {
  const video = call.offer?.mode === 'video';
  if (!livekitConfigured()) {
    throw new ApiError(503, 'DM calling is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET on the API server.');
  }
  if (!await livekitUsable()) throw new ApiError(503, 'DM calling cannot connect: LIVEKIT_URL must be a valid LiveKit WebSocket URL.');
  const roomName = dmRoomName(call);
  let profile = null;
  try { [profile] = await ctx.rest(`mw_profiles?id=eq.${ctx.user.id}&select=display_name,username,avatar_url&limit=1`) || []; } catch {}
  const token = accessToken({
    identity: ctx.user.id, room: roomName, canPublish: true, sources: video ? [CAMERA, MIC] : [MIC], ttlSeconds: 60,
    name: String(name || profile?.display_name || profile?.username || 'MilkyWay user').slice(0, 80),
    metadata: JSON.stringify({ avatar: String(profile?.avatar_url || '').slice(0, 500) }),
  });
  return { token, serverUrl: livekitUrl(), roomName, mode: video ? 'video' : 'audio' };
}

const cleanName = value => typeof value === 'string' ? value.trim().slice(0, 80) : '';

// Best-effort realtime nudge to the other person's open app (apps listen on mw-calls-<user id>).
// The signal only names the call; the client re-reads it from this API, and 1-second polling remains the fallback.
async function nudge(ctx, userId, id, kind) {
  try {
    await fetch(`${SUPABASE}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: ctx.key, Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: `mw-calls-${userId}`, event: 'call', payload: { id, kind }, private: false }] }),
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* polling covers it */ }
}

export default route({
  // GET ?id=<call> returns one call (used to check how a ringing call ended).
  '': async ({ ctx, query, method }) => {
    if (method !== 'GET') throw new ApiError(405, 'Method not allowed.');
    return { call: await loadCall(ctx, String(query.id || '')) };
  },

  start: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    if (!livekitConfigured()) {
      throw new ApiError(503, 'DM calling is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET on the API server.');
    }
    if (!await livekitUsable()) throw new ApiError(503, 'DM calling cannot connect: LIVEKIT_URL must be a valid LiveKit WebSocket URL.');
    const callee = requireUuid(body.callee, 'callee');
    if (callee === ctx.user.id) throw new ApiError(400, 'You cannot call yourself.');
    const mode = body.mode === 'video' ? 'video' : 'audio';
    const name = cleanName(body.name);
    const [existing] = await ctx.rest(
      `mw_dm_calls?select=id&status=in.(ringing,accepted)&or=(and(caller_id.eq.${ctx.user.id},callee_id.eq.${callee}),and(caller_id.eq.${callee},callee_id.eq.${ctx.user.id}))&limit=1`,
    ) || [];
    if (existing) throw new ApiError(409, 'A call with this person is already in progress.');
    // A caller only ever has one ringing call; older ones are closed as cancelled.
    const previous = await ctx.rest(`mw_dm_calls?caller_id=eq.${ctx.user.id}&status=eq.ringing`, {
      method: 'PATCH', returning: true,
      body: { status: 'ended', ended_at: new Date().toISOString(), answer: { outcome: 'cancelled' } },
    }) || [];
    for (const oldCall of previous) {
      const oldRoom = dmRoomName(oldCall);
      await closeRoom(ctx, oldRoom, { immediate: false });
    }
    const [call] = await ctx.rest('mw_dm_calls', { method: 'POST', returning: true, body: { caller_id: ctx.user.id, callee_id: callee, status: 'ringing', offer: { transport: 'livekit', mode, name } } }) || [];
    if (!call) throw new ApiError(503, 'Call could not start.');
    // Let the client request its token after opening the call UI; token issuance must not delay ringing.
    void nudge(ctx, callee, call.id, 'ring');
    return { call };
  },

  accept: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    const id = requireUuid(body.id, 'call');
    const since = new Date(Date.now() - RING_WINDOW_MS).toISOString();
    const [call] = await ctx.rest(`mw_dm_calls?id=eq.${id}&callee_id=eq.${ctx.user.id}&status=eq.ringing&created_at=gte.${encodeURIComponent(since)}`, { method: 'PATCH', returning: true, body: { status: 'accepted', answer: { acceptedAt: new Date().toISOString() } } }) || [];
    if (!call) throw new ApiError(409, 'This call is no longer ringing.');
    // The accepted client obtains its own token in connect(), so acceptance stays responsive.
    void nudge(ctx, call.caller_id, call.id, 'accepted');
    return { call };
  },

  decline: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    const id = requireUuid(body.id, 'call');
    const [call] = await ctx.rest(`mw_dm_calls?id=eq.${id}&callee_id=eq.${ctx.user.id}&status=eq.ringing`, { method: 'PATCH', returning: true, body: { status: 'declined', ended_at: new Date().toISOString(), answer: { outcome: 'rejected' } } }) || [];
    if (!call) throw new ApiError(409, 'This call is no longer ringing.');
    const cleanupPending = !await closeRoom(ctx, dmRoomName(call));
    await nudge(ctx, call.caller_id, call.id, 'declined');
    return { call, cleanupPending };
  },

  end: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    const call = await loadCall(ctx, body.id);
    let result = call;
    if (!['ended', 'declined'].includes(call.status)) {
      const outcome = OUTCOMES.includes(body.outcome) ? body.outcome : 'ended';
      const [ended] = await ctx.rest(`mw_dm_calls?id=eq.${call.id}&status=in.(ringing,accepted)`, { method: 'PATCH', returning: true, body: { status: 'ended', ended_at: new Date().toISOString(), answer: { ...(call.answer || {}), outcome } } }) || [];
      result = ended || call;
    }
    const cleanupPending = !await closeRoom(ctx, dmRoomName(call));
    await nudge(ctx, call.caller_id === ctx.user.id ? call.callee_id : call.caller_id, call.id, 'ended');
    return { call: result, cleanupPending };
  },

  incoming: async ({ ctx, method }) => {
    if (method !== 'GET') throw new ApiError(405, 'Method not allowed.');
    const [call] = await ctx.rest(`mw_dm_calls?callee_id=eq.${ctx.user.id}&status=eq.ringing&select=${COLUMNS}&order=created_at.desc&limit=1`) || [];
    return { call: call || null };
  },

  token: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    let call = await loadCall(ctx, body.id);
    if (!['ringing', 'accepted'].includes(call.status)) throw new ApiError(409, 'This call has ended.');
    const ringingAge = Date.now() - Date.parse(call.created_at);
    if (call.status === 'ringing' && (!Number.isFinite(ringingAge) || ringingAge > RING_WINDOW_MS)) {
      const [ended] = await ctx.rest(`mw_dm_calls?id=eq.${call.id}&status=eq.ringing`, {
        method: 'PATCH', returning: true,
        body: { status: 'ended', ended_at: new Date().toISOString(), answer: { outcome: 'missed' } },
      }) || [];
      call = ended || call;
      await closeRoom(ctx, dmRoomName(call), { immediate: false });
      throw new ApiError(409, 'This call has ended.');
    }
    return access(ctx, call, cleanName(body.name));
  },
});
