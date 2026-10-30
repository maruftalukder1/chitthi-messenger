// Phase 0 security regression suite.
// Expects TWO servers already running:
//   DEMO   (default http://127.0.0.1:3000) started with CHITTHI_ALLOW_UNAUTH_DEMO=true
//   STRICT (default http://127.0.0.1:3001) started with NO demo flags (token required)
// Run: node docs/qa-security-test.mjs
import WebSocket from 'ws';

const DEMO = process.env.QA_DEMO_URL || 'http://127.0.0.1:3000';
const STRICT = process.env.QA_STRICT_URL || 'http://127.0.0.1:3001';
const DEMO_WS = DEMO.replace('http', 'ws') + '/ws';
const STRICT_WS = STRICT.replace('http', 'ws') + '/ws';

let passed = 0;
const ok = (label) => { passed++; console.log('PASS', label); };

const mk = (url, name) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  const inbox = [];
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())); } catch {} });
  ws.on('open', () => res({ ws, inbox, name }));
  ws.on('error', rej);
});
const waitFor = async (client, pred, label, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = client.inbox.find(pred);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`TIMEOUT waiting ${label} for ${client.name}; inbox=${JSON.stringify(client.inbox.map(i => i.type))}`);
};
const expectSilent = async (client, pred, label, ms = 900) => {
  await new Promise(r => setTimeout(r, ms));
  if (client.inbox.find(pred)) throw new Error(`UNEXPECTED delivery (${label}) to ${client.name}`);
};
const login = async (client, userId) => {
  client.ws.send(JSON.stringify({ type: 'user:login', userId, username: userId }));
  await new Promise(r => setTimeout(r, 200));
};
const rest = async (base, method, path, { demoUser, token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (demoUser) headers['X-Demo-User'] = demoUser;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

// ---------- REST auth on channel writes (demo server) ----------
// S1: unauthenticated write rejected
{
  const r = await rest(DEMO, 'POST', '/api/channels', { body: { id: 'x1', name: 'Nope' } });
  if (r.status !== 401) throw new Error(`S1 expected 401, got ${r.status}`);
  ok('S1 channel write without auth -> 401');
}
// S2: owner forced to caller; memberIds sanitised
{
  const r = await rest(DEMO, 'POST', '/api/channels', {
    demoUser: 'dave',
    body: { id: 'sec_room', name: 'Secret', isGroup: true, ownerId: 'mallory', memberIds: ['carol'] },
  });
  if (r.status !== 200) throw new Error(`S2 expected 200, got ${r.status} ${JSON.stringify(r.json)}`);
  if (r.json.channel.ownerId !== 'dave') throw new Error('S2 ownerId not forced to caller');
  if (!r.json.channel.memberIds.includes('dave') || !r.json.channel.memberIds.includes('carol'))
    throw new Error('S2 memberIds wrong: ' + JSON.stringify(r.json.channel.memberIds));
  if (r.json.channel.membersCount !== 2) throw new Error('S2 membersCount not derived');
  ok('S2 channel create forces owner + memberIds');
}
// S3: non-owner update rejected
{
  const r = await rest(DEMO, 'POST', '/api/channels', {
    demoUser: 'eve',
    body: { id: 'sec_room', name: 'Hijacked', isGroup: true },
  });
  if (r.status !== 403) throw new Error(`S3 expected 403, got ${r.status}`);
  ok('S3 non-owner channel update -> 403');
}

// ---------- Room-scoped access over WS (demo server) ----------
const carol = await mk(DEMO_WS, 'carol');
const eve = await mk(DEMO_WS, 'eve');
await login(carol, 'carol');
await login(eve, 'eve');
carol.ws.send(JSON.stringify({ type: 'room:join', roomId: 'sec_room' }));
await waitFor(carol, m => m.type === 'room:history' && m.roomId === 'sec_room', 'carol history');
ok('S4a member receives room history');
eve.ws.send(JSON.stringify({ type: 'room:join', roomId: 'sec_room' }));
await waitFor(eve, m => m.type === 'room:denied' && m.roomId === 'sec_room', 'eve denied');
ok('S4b non-member room:join denied');
const SEC_ID = 'sec_' + Date.now();
carol.ws.send(JSON.stringify({ type: 'message:send', message: { id: SEC_ID, senderId: 'carol', senderName: 'Carol', senderAvatar: '', roomId: 'sec_room', type: 'text', content: 'members only', timestamp: Date.now() } }));
await expectSilent(eve, m => m.type === 'message:new' && m.message?.id === SEC_ID, 'member message leaked to non-member');
ok('S4c member message not delivered to non-member');
eve.ws.send(JSON.stringify({ type: 'message:send', message: { id: SEC_ID + '_x', senderId: 'eve', senderName: 'Eve', senderAvatar: '', roomId: 'sec_room', type: 'text', content: 'intrusion', timestamp: Date.now() } }));
await expectSilent(carol, m => m.type === 'message:new' && m.message?.id === SEC_ID + '_x', 'non-member message delivered');
ok('S4d non-member message:send dropped');

// ---------- Receipts (DM room) ----------
const alice = await mk(DEMO_WS, 'alice');
const bob = await mk(DEMO_WS, 'bob');
await login(alice, 'alice');
await login(bob, 'bob');
alice.ws.send(JSON.stringify({ type: 'room:join', roomId: 'alice__bob' }));
bob.ws.send(JSON.stringify({ type: 'room:join', roomId: 'alice__bob' }));
await new Promise(r => setTimeout(r, 250));
const DM_ID = 'dm_' + Date.now();
alice.ws.send(JSON.stringify({ type: 'message:send', message: { id: DM_ID, senderId: 'alice', senderName: 'Alice', senderAvatar: '', roomId: 'alice__bob', type: 'text', content: 'receipt test', timestamp: Date.now() } }));
await waitFor(bob, m => m.type === 'message:new' && m.message?.id === DM_ID, 'bob receives dm');
const rc1 = await waitFor(alice, m => m.type === 'message:receipts' && m.messageId === DM_ID && (m.deliveredTo || []).includes('bob'), 'delivered receipt');
ok('S5a delivered receipt reaches sender');
bob.ws.send(JSON.stringify({ type: 'message:read', roomId: 'alice__bob', messageIds: [DM_ID] }));
await waitFor(alice, m => m.type === 'message:receipts' && m.messageId === DM_ID && (m.readBy || []).includes('bob'), 'read receipt');
ok('S5b read receipt reaches sender');

// ---------- Block enforcement ----------
{
  const r = await rest(DEMO, 'POST', '/api/blocks', { demoUser: 'alice', body: { blockedId: 'bob' } });
  if (r.status !== 200) throw new Error(`S6 block POST failed ${r.status}`);
}
const BLK_ID = 'blk_' + Date.now();
bob.ws.send(JSON.stringify({ type: 'message:send', message: { id: BLK_ID, senderId: 'bob', senderName: 'Bob', senderAvatar: '', roomId: 'alice__bob', type: 'text', content: 'you blocked me?', timestamp: Date.now() } }));
await expectSilent(alice, m => m.type === 'message:new' && m.message?.id === BLK_ID, 'blocked DM delivered');
ok('S6a blocked user DM dropped server-side');
bob.ws.send(JSON.stringify({ type: 'call:signal', targetUserId: 'alice', signalType: 'invite', roomId: 'r9', signal: { callType: 'audio' } }));
await expectSilent(alice, m => m.type === 'call:signal' && m.signalType === 'invite', 'blocked invite rang');
ok('S6b blocked user call invite dropped');
await rest(DEMO, 'DELETE', '/api/blocks/bob', { demoUser: 'alice' });

// ---------- Poll anonymity ----------
await rest(DEMO, 'POST', '/api/channels', {
  demoUser: 'dave',
  body: { id: 'poll_room', name: 'Polls', isGroup: true, memberIds: ['carol', 'frank'] },
});
const frank = await mk(DEMO_WS, 'frank');
const dave = await mk(DEMO_WS, 'dave');
await login(frank, 'frank');
await login(dave, 'dave');
for (const c of [dave, carol, frank]) c.ws.send(JSON.stringify({ type: 'room:join', roomId: 'poll_room' }));
await new Promise(r => setTimeout(r, 250));
const POLL_ID = 'poll_' + Date.now();
dave.ws.send(JSON.stringify({ type: 'message:send', message: { id: POLL_ID, senderId: 'dave', senderName: 'Dave', senderAvatar: '', roomId: 'poll_room', type: 'text', content: '', timestamp: Date.now(), poll: { question: 'Lunch?', options: [{ id: 'o1', text: 'Yes', voterIds: [] }, { id: 'o2', text: 'No', voterIds: [] }] } } }));
await waitFor(frank, m => m.type === 'message:new' && m.message?.id === POLL_ID, 'frank sees poll');
carol.ws.send(JSON.stringify({ type: 'message:update', messageId: POLL_ID, roomId: 'poll_room', patch: { poll: { question: 'Lunch?', options: [{ id: 'o1', text: 'Yes', voterIds: ['carol'] }, { id: 'o2', text: 'No', voterIds: [] }] } } }));
const frankCopy = await waitFor(frank, m => m.type === 'message:updated' && m.message?.id === POLL_ID, 'frank poll update');
const fo = frankCopy.message.poll.options.find(o => o.id === 'o1');
if (!Array.isArray(fo.voterIds) || fo.voterIds.length !== 0 || fo.voterCount !== 1)
  throw new Error('S7 frank copy leaks voterIds or lacks voterCount: ' + JSON.stringify(fo));
ok('S7a poll voterIds hidden from non-admin member, voterCount present');
const daveCopy = await waitFor(dave, m => m.type === 'message:updated' && m.message?.id === POLL_ID, 'dave poll update');
const dopt = daveCopy.message.poll.options.find(o => o.id === 'o1');
if (!(dopt.voterIds || []).includes('carol')) throw new Error('S7 sender copy lost voterIds');
ok('S7b poll creator still sees voterIds');

// ---------- Expiring messages do not resurrect ----------
const EXP_ID = 'exp_' + Date.now();
alice.ws.send(JSON.stringify({ type: 'message:send', message: { id: EXP_ID, senderId: 'alice', senderName: 'Alice', senderAvatar: '', roomId: 'alice__bob', type: 'text', content: 'gone', timestamp: Date.now(), expiresAt: Date.now() - 1000 } }));
await new Promise(r => setTimeout(r, 300));
const late = await mk(DEMO_WS, 'late-alice');
await login(late, 'alice');
late.ws.send(JSON.stringify({ type: 'room:join', roomId: 'alice__bob' }));
const hist = await waitFor(late, m => m.type === 'room:history' && m.roomId === 'alice__bob', 'late history');
if (hist.messages.some(m => m.id === EXP_ID)) throw new Error('S8 expired message resurrected in history');
ok('S8 expired message excluded from history');

// ---------- Stories + blocks REST auth ----------
{
  const r = await rest(DEMO, 'GET', '/api/stories', {});
  if (r.status !== 401) throw new Error(`S9 expected 401 for unauth stories, got ${r.status}`);
  const c = await rest(DEMO, 'POST', '/api/stories', { demoUser: 'alice', body: { media: 'data:image/png;base64,xxxx', type: 'image', userName: 'Alice', userAvatar: '' } });
  if (c.status !== 200 || !c.json.story?.id) throw new Error('S9 story create failed');
  const list = await rest(DEMO, 'GET', '/api/stories', { demoUser: 'bob' });
  if (!list.json.stories.some(s => s.id === c.json.story.id)) throw new Error('S9 story not listed for bob');
  const del = await rest(DEMO, 'DELETE', `/api/stories/${c.json.story.id}`, { demoUser: 'bob' });
  if (del.status !== 403) throw new Error(`S9 expected 403 deleting other's story, got ${del.status}`);
  ok('S9 stories API auth + author-only delete');
}

// ---------- STRICT server: tokens are actually required ----------
{
  const c1 = await mk(STRICT_WS, 'strict-anon');
  c1.ws.send(JSON.stringify({ type: 'user:login', userId: 'alice', username: 'Alice' }));
  const err = await waitFor(c1, m => m.type === 'auth:error', 'token_required');
  if (err.error !== 'token_required') throw new Error('T1 wrong error: ' + err.error);
  ok('T1 strict server rejects tokenless login (token_required)');
  c1.ws.close();
}
{
  const c2 = await mk(STRICT_WS, 'strict-bad');
  c2.ws.send(JSON.stringify({ type: 'user:login', userId: 'alice', username: 'Alice', idToken: 'aaa.bbb.ccc' }));
  const err = await waitFor(c2, m => m.type === 'auth:error', 'invalid_token');
  if (err.error !== 'invalid_token') throw new Error('T2 wrong error: ' + err.error);
  ok('T2 strict server rejects garbage token (invalid_token)');
  c2.ws.close();
}
{
  const r = await rest(STRICT, 'POST', '/api/channels', { body: { id: 'zz', name: 'Z' } });
  if (r.status !== 401) throw new Error(`T3 expected 401, got ${r.status}`);
  const r2 = await rest(STRICT, 'POST', '/api/channels', { token: 'aaa.bbb.ccc', body: { id: 'zz', name: 'Z' } });
  if (r2.status !== 401) throw new Error(`T3b expected 401, got ${r2.status}`);
  ok('T3 strict REST writes reject missing/garbage auth');
}

// ---------- Phase 1: usernames (claim conflict + reserved) ----------
{
  const c1 = await rest(DEMO, 'POST', '/api/usernames/claim', { demoUser: 'user_one', body: { handle: 'cool_handle1' } });
  if (c1.status !== 200 || c1.json.username !== 'cool_handle1') throw new Error(`P1a claim failed ${c1.status} ${JSON.stringify(c1.json)}`);
  ok('P1a username claim succeeds');
  const c2 = await rest(DEMO, 'POST', '/api/usernames/claim', { demoUser: 'user_two', body: { handle: 'cool_handle1' } });
  if (c2.status !== 409 || c2.json.reason !== 'taken') throw new Error(`P1b expected 409/taken, got ${c2.status} ${JSON.stringify(c2.json)}`);
  ok('P1b username claim conflict -> 409 taken');
  const c3 = await rest(DEMO, 'POST', '/api/usernames/claim', { demoUser: 'user_two', body: { handle: 'admin' } });
  if (c3.status === 200 || c3.json.reason !== 'reserved') throw new Error(`P1c expected reserved rejection, got ${c3.status} ${JSON.stringify(c3.json)}`);
  ok('P1c reserved username rejected');
  const chk = await rest(DEMO, 'GET', '/api/usernames/check?handle=cool_handle1', { demoUser: 'user_two' });
  if (chk.json.available !== false || chk.json.reason !== 'taken') throw new Error('P1d check endpoint wrong: ' + JSON.stringify(chk.json));
  const chk2 = await rest(DEMO, 'GET', '/api/usernames/check?handle=free_handle9', { demoUser: 'user_two' });
  if (chk2.json.available !== true) throw new Error('P1d free handle not available: ' + JSON.stringify(chk2.json));
  ok('P1d username check endpoint (taken + available)');
}

// ---------- Phase 1: member self-service channel updates (addendum) ----------
{
  await rest(DEMO, 'POST', '/api/channels', {
    demoUser: 'leave_owner',
    body: { id: 'leave_room', name: 'Leave Room', isGroup: true, memberIds: ['leave_member', 'leave_other'] },
  });
  // (c) member may write events/RSVPs
  const ev = await rest(DEMO, 'POST', '/api/channels', {
    demoUser: 'leave_member',
    body: { id: 'leave_room', name: 'Leave Room', isGroup: true, events: [{ id: 'ev1', title: 'Party', startsAt: Date.now() + 3600e3, createdBy: 'leave_member', rsvps: { leave_member: 'yes' } }] },
  });
  if (ev.status !== 200) throw new Error(`P2a member events update expected 200, got ${ev.status} ${JSON.stringify(ev.json)}`);
  if (!Array.isArray(ev.json.channel.events) || ev.json.channel.events[0]?.rsvps?.leave_member !== 'yes')
    throw new Error('P2a RSVP not persisted');
  ok('P2a member event/RSVP update allowed + persisted');
  // member rename attempt -> 403
  const rn = await rest(DEMO, 'POST', '/api/channels', {
    demoUser: 'leave_member',
    body: { id: 'leave_room', name: 'Hijacked Name', isGroup: true },
  });
  if (rn.status !== 403) throw new Error(`P2b member rename expected 403, got ${rn.status}`);
  ok('P2b member rename attempt -> 403');
  // (a) member self-removal (leave) persists
  const lv = await rest(DEMO, 'POST', '/api/channels', {
    demoUser: 'leave_member',
    body: { id: 'leave_room', name: 'Leave Room', isGroup: true, memberIds: ['leave_owner', 'leave_other'] },
  });
  if (lv.status !== 200) throw new Error(`P2c member leave expected 200, got ${lv.status} ${JSON.stringify(lv.json)}`);
  if ((lv.json.channel.memberIds || []).includes('leave_member')) throw new Error('P2c member still in memberIds');
  const list = await rest(DEMO, 'GET', '/api/channels', {});
  const stored = (list.json.channels || []).find(c => c.id === 'leave_room');
  if (!stored || (stored.memberIds || []).includes('leave_member')) throw new Error('P2c leave not persisted in channel list');
  ok('P2c member self-leave allowed + persisted');
}

// ---------- Phase 1: scheduled create -> fire delivery ----------
await rest(DEMO, 'POST', '/api/channels', {
  demoUser: 'sched_owner',
  body: { id: 'sched_room', name: 'Sched', isGroup: true, memberIds: ['sched_peer'] },
});
const schedOwner = await mk(DEMO_WS, 'sched_owner');
const schedPeer = await mk(DEMO_WS, 'sched_peer');
await login(schedOwner, 'sched_owner');
await login(schedPeer, 'sched_peer');
schedOwner.ws.send(JSON.stringify({ type: 'room:join', roomId: 'sched_room' }));
schedPeer.ws.send(JSON.stringify({ type: 'room:join', roomId: 'sched_room' }));
await new Promise(r => setTimeout(r, 250));
{
  const sc = await rest(DEMO, 'POST', '/api/scheduled', {
    demoUser: 'sched_owner',
    body: { roomId: 'sched_room', dueAt: Date.now() + 100, message: { type: 'text', content: 'scheduled hello fires' } },
  });
  if (sc.status !== 200 || !sc.json.scheduled?.id) throw new Error(`P3a scheduled create failed ${sc.status} ${JSON.stringify(sc.json)}`);
  const got = await waitFor(schedPeer, m => m.type === 'message:new' && (m.message?.content || '').includes('scheduled hello'), 'scheduled delivery', 12000);
  if (got.message.roomId !== 'sched_room') throw new Error('P3 wrong room for scheduled delivery');
  ok('P3a scheduled message delivered to room member by sweeper');
  const sent = await waitFor(schedOwner, m => m.type === 'scheduled:sent' && m.id === sc.json.scheduled.id, 'scheduled:sent notice', 6000);
  if (!sent.messageId) throw new Error('P3b scheduled:sent lacks messageId');
  ok('P3b owner notified scheduled:sent with messageId');
}

// ---------- Phase 1: global search membership scoping ----------
{
  const inside = await rest(DEMO, 'GET', `/api/search?q=${encodeURIComponent('scheduled hello')}`, { demoUser: 'sched_peer' });
  if (!(inside.json.results || []).some(r => r.roomId === 'sched_room')) throw new Error('P4a member search missed room message: ' + JSON.stringify(inside.json).slice(0, 200));
  ok('P4a member finds message via /api/search');
  const outside = await rest(DEMO, 'GET', `/api/search?q=${encodeURIComponent('scheduled hello')}`, { demoUser: 'mallory_search' });
  if ((outside.json.results || []).some(r => r.roomId === 'sched_room')) throw new Error('P4b search leaked a room the caller cannot access');
  ok('P4b non-member search does not leak room messages');
}

// ---------- Phase 1: upload roundtrip ----------
{
  const payload = Buffer.from('hello upload roundtrip').toString('base64');
  const up = await rest(DEMO, 'POST', '/api/uploads', { demoUser: 'alice', body: { name: 'note.txt', mime: 'text/plain', dataBase64: payload } });
  if (up.status !== 200 || !up.json.url || !/^\/uploads\/[a-f0-9]{24}\.txt$/.test(up.json.url))
    throw new Error(`P5a upload failed ${up.status} ${JSON.stringify(up.json)}`);
  const res = await fetch(DEMO + up.json.url);
  const text = await res.text();
  if (res.status !== 200 || text !== 'hello upload roundtrip') throw new Error(`P5b upload GET roundtrip failed ${res.status}: ${text}`);
  ok('P5 upload roundtrip (POST /api/uploads -> GET /uploads/:file)');
}

// ---------- Phase 1: stars roundtrip ----------
{
  const st = await rest(DEMO, 'POST', '/api/stars', { demoUser: 'star_user', body: { message: { id: 'star_msg_1', senderId: 'bob', senderName: 'Bob', roomId: 'alice__bob', type: 'text', content: 'star me', timestamp: Date.now() } } });
  if (st.status !== 200) throw new Error(`P6a star POST failed ${st.status}`);
  const g1 = await rest(DEMO, 'GET', '/api/stars', { demoUser: 'star_user' });
  if (!(g1.json.stars || []).some(s => s.id === 'star_msg_1')) throw new Error('P6b star not listed');
  const del = await rest(DEMO, 'DELETE', '/api/stars/star_msg_1', { demoUser: 'star_user' });
  if (del.status !== 200) throw new Error(`P6c star DELETE failed ${del.status}`);
  const g2 = await rest(DEMO, 'GET', '/api/stars', { demoUser: 'star_user' });
  if ((g2.json.stars || []).some(s => s.id === 'star_msg_1')) throw new Error('P6d star still listed after delete');
  ok('P6 stars roundtrip (POST -> GET -> DELETE -> GET)');
}

for (const c of [carol, eve, alice, bob, frank, dave, late, schedOwner, schedPeer]) { try { c.ws.close(); } catch {} }
console.log(`ALL SECURITY TESTS PASSED (${passed} checks)`);
