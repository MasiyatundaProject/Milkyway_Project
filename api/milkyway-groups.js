import { route, ApiError, requireUuid, eq, isUuid } from './_lib/supa.js';

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const groupName = value => {
  const name = text(value, 70);
  if (!name) throw new ApiError(400, 'Group name is required.');
  return name;
};
const groupJoinMode = value => {
  const mode = value == null || value === '' ? 'invite_only' : String(value);
  if (!['open', 'request_approval', 'invite_only'].includes(mode)) throw new ApiError(400, 'Invalid group join mode.');
  return mode;
};
const uuidList = (value, max = 255) => {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.filter(isUuid).map(id => id.toLowerCase()))].slice(0, max);
};
const groupId = (body, query) => requireUuid(String(body.group || body.id || query.id || query.group || ''), 'group');

export default route({
  list: async ({ ctx }) => {
    const rows = await ctx.rest(`mw_dm_group_members?select=role,join_status,joined_at,mw_dm_groups(id,name,caption,avatar_url,join_mode,created_at)&user_id=${eq(ctx.user.id)}&limit=500`);
    const groups = (rows || [])
      .filter(row => row.mw_dm_groups)
      .map(row => ({
        id: row.mw_dm_groups.id, name: row.mw_dm_groups.name,
        caption: row.mw_dm_groups.caption || '', avatar_url: row.mw_dm_groups.avatar_url || '',
        join_mode: row.mw_dm_groups.join_mode || 'invite_only',
        role: row.role, join_status: row.join_status || 'active',
        created_at: row.mw_dm_groups.created_at,
      }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { groups };
  },

  discover: async ({ ctx, query }) => {
    const search = text(query.q, 50).replace(/[%*,()"\\]/g, '');
    const filter = search ? `&name=ilike.${encodeURIComponent(`*${search}*`)}` : '';
    const rows = await ctx.rest(`mw_dm_groups?select=id,name,caption,avatar_url,join_mode,created_at&join_mode=in.(open,request_approval)${filter}&order=created_at.desc&limit=50`);
    return { groups: rows || [] };
  },

  group: async ({ ctx, query, body }) => {
    const id = groupId(body, query);
    const [groups, members, blocked] = await Promise.all([
      ctx.rest(`mw_dm_groups?select=id,name,caption,description,avatar_url,join_mode,members_can_invite,created_by,created_at&id=${eq(id)}&limit=1`),
      ctx.rest(`mw_dm_group_members?select=user_id,role,join_status,joined_at,invited_by&group_id=${eq(id)}&order=joined_at.asc&limit=500`),
      ctx.rest(`mw_dm_group_blocks?select=user_id,created_at&group_id=${eq(id)}&limit=500`).catch(error => {
        if (error.status === 403) return [];
        throw error;
      }),
    ]);
    const group = groups?.[0];
    const mine = (members || []).find(member => member.user_id === ctx.user.id);
    if (!group || (!mine && !['open', 'request_approval'].includes(group.join_mode))) throw new ApiError(404, 'Group not found.');
    return {
      group: {
        ...group, caption: group.caption || '', description: group.description || '',
        avatar_url: group.avatar_url || '', join_mode: group.join_mode || 'invite_only',
        members_can_invite: group.members_can_invite !== false,
        role: mine?.role || '', join_status: mine?.join_status || '',
      },
      members: members || [], blocked: blocked || [],
    };
  },

  create: async ({ ctx, body }) => {
    const id = await ctx.rpc('mw_group_create_advanced', {
      p_name: groupName(body.name),
      p_caption: text(body.caption, 120),
      p_description: text(body.description, 1000),
      p_avatar_url: text(body.avatarUrl, 1000),
      p_join_mode: groupJoinMode(body.joinMode),
      p_members_can_invite: body.membersCanInvite !== false,
      p_members: uuidList(body.members),
    });
    const groups = await ctx.rest(`mw_dm_groups?select=id,name,caption,description,avatar_url,join_mode,members_can_invite,created_by,created_at&id=${eq(id)}&limit=1`);
    return { group: { ...(groups?.[0] || { id, name: groupName(body.name) }), role: 'admin' } };
  },

  update: async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_update_settings', {
      p_group: groupId(body, query),
      p_name: groupName(body.name),
      p_caption: text(body.caption, 120),
      p_description: text(body.description, 1000),
      p_avatar_url: text(body.avatarUrl, 1000),
      p_join_mode: groupJoinMode(body.joinMode),
      p_members_can_invite: body.membersCanInvite !== false,
    });
    return { ok: true };
  },

  'add-member': async ({ ctx, body, query }) => {
    const added = await ctx.rpc('mw_group_add_members', {
      p_group: groupId(body, query),
      p_users: uuidList(body.userIds || body.members),
    });
    return { added: Number(added) || 0 };
  },

  'set-role': async ({ ctx, body, query }) => {
    const role = String(body.role || '');
    if (!['admin', 'co_admin', 'member'].includes(role)) throw new ApiError(400, 'Invalid role.');
    await ctx.rpc('mw_group_set_role', { p_group: groupId(body, query), p_user: requireUuid(body.userId, 'user'), p_role: role });
    return { ok: true };
  },

  join: async ({ ctx, body, query }) => {
    const status = await ctx.rpc('mw_group_join', { p_group: groupId(body, query) });
    return { status };
  },

  'decide-request': async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_join_request_decide', {
      p_group: groupId(body, query),
      p_user: requireUuid(body.userId, 'user'),
      p_approve: body.approve === true,
    });
    return { ok: true };
  },

  'remove-member': async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_remove_member', { p_group: groupId(body, query), p_user: requireUuid(body.userId, 'user'), p_block: body.block === true });
    return { ok: true };
  },

  unblock: async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_unblock', { p_group: groupId(body, query), p_user: requireUuid(body.userId, 'user') });
    return { ok: true };
  },

  leave: async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_leave', { p_group: groupId(body, query) });
    return { ok: true };
  },

  delete: async ({ ctx, body, query }) => {
    await ctx.rpc('mw_group_delete', { p_group: groupId(body, query) });
    return { ok: true };
  },

  send: async ({ ctx, body }) => {
    const group = requireUuid(String(body.group || ''), 'group');
    const message = String(body.body ?? '').trim();
    if (!message || message.length > 4000) throw new ApiError(400, 'Message must be 1-4000 characters.');
    const row = { group_id: group, sender_id: ctx.user.id, body: message };
    if (isUuid(body.id)) row.id = body.id;
    // A retried send with the same client id is ignored rather than duplicated.
    const rows = await ctx.rest('mw_dm_group_messages?on_conflict=id', { method: 'POST', body: row, returning: true, prefer: 'resolution=ignore-duplicates' });
    return { message: rows?.[0] || { ...row, created_at: new Date().toISOString() } };
  },

  messages: async ({ ctx, query, body }) => {
    const group = groupId(body, query);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 200);
    const rows = await ctx.rest(`mw_dm_group_messages?select=id,sender_id,body,created_at,edited_at&group_id=${eq(group)}&order=created_at.desc&limit=${limit}`);
    return { messages: rows || [] };
  },

  'delete-message': async ({ ctx, body }) => {
    const id = requireUuid(String(body.id || ''), 'message');
    await ctx.rest(`mw_dm_group_messages?id=${eq(id)}&sender_id=${eq(ctx.user.id)}`, { method: 'DELETE' });
    return { ok: true };
  },
});
