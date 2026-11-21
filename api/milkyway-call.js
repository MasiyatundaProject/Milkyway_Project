import { route, ApiError, SUPABASE, requireUuid } from './_lib/supa.js';
import { livekitUrl, livekitConfigurationError, accessToken, closeRoom, livekit, CAMERA, MIC, CALL_TOKEN_TTL_SECONDS } from './_lib/livekit.js';

const OUTCOMES = ['ended', 'missed', 'cancelled', 'rejected', 'disconnected'];
const RING_WINDOW_MS = 60000;
const ACCEPTED_CONNECT_GRACE_MS = 30_000;
const ACCEPTED_MAX_AGE_MS = 24 * 60 * 60_000;
const COLUMNS = 'id,caller_id,callee_id,status,offer,answer,created_at,ended_at';
const POST_ONLY = method => { if (method !== 'POST') throw new ApiError(405, 'Method not allowed.'); };
const dmRoomName = call => `dm-call-${[call.caller_id, call.callee_id].map(id => id.toLowerCase()).sort().join('-')}`;
const callTypeOf = call => call?.offer?.callType === 'video' || call?.offer?.mode === 'video' || call?.offer?.videoEnabled === true ? 'video' : 'audio';

async function loadCall(ctx, id) {
  const [call] = await ctx.rest(`mw_dm_calls?id=eq.${requireUuid(id, 'call')}&select=${COLUMNS}&limit=1`) || [];
  if (!call) throw new ApiError(404, 'Call not found.');
  if (![call.caller_id, call.callee_id].includes(ctx.user.id)) throw new ApiError(403, 'Not allowed.');
  return call;
}

// Issues a participant-scoped token for the deterministic room shared by the two call participants.
async function access(ctx, call, name) {
  const callType = callTypeOf(call);
  const videoEnabled = callType === 'video';
  const configError = livekitConfigurationError(ctx.env);
  if (configError) throw new ApiError(503, configError);
  const roomName = dmRoomName(call);
  let profile = null;
  try { [profile] = await ctx.rest(`mw_profiles?id=eq.${ctx.user.id}&select=display_name,username,avatar_url&limit=1`) || []; } catch {}
  const token = accessToken({
    identity: ctx.user.id, room: roomName, canPublish: true, sources: videoEnabled ? [CAMERA, MIC] : [MIC], ttlSeconds: CALL_TOKEN_TTL_SECONDS,
    name: String(name || profile?.display_name || profile?.username || 'MilkyWay user').slice(0, 80),
    metadata: JSON.stringify({ avatar: String(profile?.avatar_url || '').slice(0, 500), callType, videoEnabled }),
  }, ctx.env);
  return { token, serverUrl: livekitUrl(ctx.env), roomName, mode: callType, callType, videoEnabled };
}

const cleanName = value => typeof value === 'string' ? value.trim().slice(0, 80) : '';

// Best-effort realtime nudge to the other person's open app (apps listen on mw-calls-<user id>).
// The signal includes call type for fast UI setup; the client re-reads the call, and polling remains the fallback.
async function nudge(ctx, userId, id, kind, callType = 'audio') {
  try {
    await fetch(`${SUPABASE}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: ctx.key, Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: `mw-calls-${userId}`, event: 'call', payload: { id, kind, callType, videoEnabled: callType === 'video' }, private: false }] }),
      signal: AbortSignal.timeout(4000),
    });
  } catch { /* polling covers it */ }
}

async function endStaleCall(ctx, call) {
  const now = Date.now();
  if (call.status === 'ringing') {
    const age = now - Date.parse(call.created_at);
    if (Number.isFinite(age) && age <= RING_WINDOW_MS) return false;
  } else if (call.status === 'accepted') {
    const acceptedAt = Date.parse(call.answer?.acceptedAt || call.created_at);
    const age = Number.isFinite(acceptedAt) ? now - acceptedAt : Infinity;
    if (age <= ACCEPTED_CONNECT_GRACE_MS) return false;
    if (age <= ACCEPTED_MAX_AGE_MS) {
      try {
        const room = await livekit('ListParticipants', dmRoomName(call), {}, null, ctx.env);
        if (room?.participants?.length) return false;
      } catch (error) {
        console.warn('[call] Could not verify whether an accepted call is stale.', {
          callId: call.id, message: error?.message || String(error),
        });
        return false;
      }
    }
  } else return false;

  const outcome = call.status === 'ringing' ? 'missed' : 'disconnected';
  const [ended] = await ctx.rest(`mw_dm_calls?id=eq.${call.id}&status=eq.${call.status}`, {
    method: 'PATCH', returning: true,
    body: { status: 'ended', ended_at: new Date().toISOString(), answer: { ...(call.answer || {}), outcome } },
  }) || [];
  if (!ended) return true;
  await closeRoom(ctx, dmRoomName(call), { immediate: false });
  void nudge(ctx, call.caller_id === ctx.user.id ? call.callee_id : call.caller_id, call.id, 'ended');
  return true;
}

export default route({
  // GET ?id=<call> returns one call (used to check how a ringing call ended).
  '': async ({ ctx, query, method }) => {
    if (method !== 'GET') throw new ApiError(405, 'Method not allowed.');
    return { call: await loadCall(ctx, String(query.id || '')) };
  },

  start: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    const configError = livekitConfigurationError(ctx.env);
    if (configError) throw new ApiError(503, configError);
    const callee = requireUuid(body.callee, 'callee');
    if (callee === ctx.user.id) throw new ApiError(400, 'You cannot call yourself.');
    const callType = body.callType === 'video' || body.mode === 'video' || body.videoEnabled === true ? 'video' : 'audio';
    const videoEnabled = callType === 'video';
    const name = cleanName(body.name);
    const existing = await ctx.rest(
      `mw_dm_calls?select=${COLUMNS}&status=in.(ringing,accepted)&or=(and(caller_id.eq.${ctx.user.id},callee_id.eq.${callee}),and(caller_id.eq.${callee},callee_id.eq.${ctx.user.id}))&order=created_at.desc&limit=10`,
    ) || [];
    for (const activeCall of existing) {
      if (!await endStaleCall(ctx, activeCall)) throw new ApiError(409, 'A call with this person is already in progress.');
    }
    // A caller only ever has one ringing call; older ones are closed as cancelled.
    const previous = await ctx.rest(`mw_dm_calls?caller_id=eq.${ctx.user.id}&status=eq.ringing`, {
      method: 'PATCH', returning: true,
      body: { status: 'ended', ended_at: new Date().toISOString(), answer: { outcome: 'cancelled' } },
    }) || [];
    for (const oldCall of previous) {
      const oldRoom = dmRoomName(oldCall);
      await closeRoom(ctx, oldRoom, { immediate: false });
    }
    const [call] = await ctx.rest('mw_dm_calls', { method: 'POST', returning: true, body: { caller_id: ctx.user.id, callee_id: callee, status: 'ringing', offer: { transport: 'livekit', mode: callType, callType, videoEnabled, name } } }) || [];
    if (!call) throw new ApiError(503, 'Call could not start.');
    // Let the client request its token after opening the call UI; token issuance must not delay ringing.
    void nudge(ctx, callee, call.id, 'ring', callType);
    return { call, callType, videoEnabled };
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
    const since = new Date(Date.now() - RING_WINDOW_MS).toISOString();
    const [call] = await ctx.rest(`mw_dm_calls?callee_id=eq.${ctx.user.id}&status=eq.ringing&created_at=gte.${encodeURIComponent(since)}&select=${COLUMNS}&order=created_at.desc&limit=1`) || [];
    return { call: call || null };
  },

  reset: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    const peer = requireUuid(body.peer, 'peer');
    if (peer === ctx.user.id) throw new ApiError(400, 'Invalid conversation.');
    const calls = await ctx.rest(
      `mw_dm_calls?select=${COLUMNS}&status=in.(ringing,accepted)&or=(and(caller_id.eq.${ctx.user.id},callee_id.eq.${peer}),and(caller_id.eq.${peer},callee_id.eq.${ctx.user.id}))&limit=10`,
    ) || [];
    let endedCount = 0;
    for (const call of calls) {
      const [ended] = await ctx.rest(`mw_dm_calls?id=eq.${call.id}&status=eq.${call.status}`, {
        method: 'PATCH', returning: true,
        body: { status: 'ended', ended_at: new Date().toISOString(), answer: { ...(call.answer || {}), outcome: 'disconnected' } },
      }) || [];
      if (!ended) continue;
      endedCount++;
      await closeRoom(ctx, dmRoomName(call), { immediate: false });
      void nudge(ctx, call.caller_id === ctx.user.id ? call.callee_id : call.caller_id, call.id, 'ended');
    }
    return { ended: endedCount };
  },

  token: async ({ ctx, body, method }) => {
    POST_ONLY(method);
    const call = await loadCall(ctx, body.id);
    if (!['ringing', 'accepted'].includes(call.status)) throw new ApiError(409, 'This call has ended.');
    if (await endStaleCall(ctx, call)) throw new ApiError(409, 'This call has ended.');
    return access(ctx, call, cleanName(body.name));
  },
});
