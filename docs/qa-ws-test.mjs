import WebSocket from 'ws';
const URL = 'ws://127.0.0.1:3000/ws';
const mk = (name) => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
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
  throw new Error(`TIMEOUT waiting ${label} for ${client.name}; inbox=${JSON.stringify(client.inbox.map(i=>i.type))}`);
};
const A = await mk('Alice'); const B = await mk('Bob');
A.ws.send(JSON.stringify({ type: 'user:login', userId: 'alice', username: 'Alice' }));
B.ws.send(JSON.stringify({ type: 'user:login', userId: 'bob', username: 'Bob' }));
await new Promise(r => setTimeout(r, 300));
// 1. chat message broadcast
A.ws.send(JSON.stringify({ type: 'room:join', roomId: 'fullsnack_designers' }));
B.ws.send(JSON.stringify({ type: 'room:join', roomId: 'fullsnack_designers' }));
// Unique id per run: the server persists room history, so a fixed id would
// collide with earlier runs' stored copies (the react handler finds the
// oldest stored message with that id).
const QA_ID = 'qa_' + Date.now();
A.ws.send(JSON.stringify({ type: 'message:send', message: { id: QA_ID, senderId: 'alice', senderName: 'Alice', senderAvatar: '', roomId: 'fullsnack_designers', type: 'text', content: 'qa hello bob', timestamp: Date.now() } }));
await waitFor(B, m => m.type === 'message:new' && m.message?.id === QA_ID, 'message:new');
console.log('PASS 1 message broadcast A->B');
// 2. typing relay
A.ws.send(JSON.stringify({ type: 'typing:indicator', roomId: 'fullsnack_designers', userId: 'alice', username: 'Alice', isTyping: true }));
await waitFor(B, m => m.type === 'typing:indicator' && m.userId === 'alice', 'typing');
console.log('PASS 2 typing relay');
// 3. reaction relay — the server stamps the reactor from the login session
// (security fix: payload userId is ignored, so A reacts as 'alice' even if
// the frame claims to be someone else)
A.ws.send(JSON.stringify({ type: 'message:react', messageId: QA_ID, roomId: 'fullsnack_designers', emoji: '❤️', userId: 'bob' }));
await waitFor(B, m => m.type === 'message:updated' && m.message?.reactions?.['❤️']?.includes('alice') && !m.message?.reactions?.['❤️']?.includes('bob'), 'reaction');
console.log('PASS 3 reaction broadcast');
// 4. call signaling: invite targeted bob -> accept -> offer -> answer -> ice -> end
A.ws.send(JSON.stringify({ type: 'call:signal', targetUserId: 'bob', signalType: 'invite', roomId: 'r1', signal: { callType: 'video', fromId: 'alice', fromName: 'Alice' } }));
const inv = await waitFor(B, m => m.type === 'call:signal' && m.signalType === 'invite', 'invite');
console.log('PASS 4a invite relay, fromUserId =', inv.fromUserId);
B.ws.send(JSON.stringify({ type: 'call:signal', targetUserId: 'alice', signalType: 'accept', roomId: 'r1' }));
await waitFor(A, m => m.type === 'call:signal' && m.signalType === 'accept', 'accept');
console.log('PASS 4b accept relay');
B.ws.send(JSON.stringify({ type: 'call:signal', targetUserId: 'alice', signalType: 'end', roomId: 'r1' }));
await waitFor(A, m => m.type === 'call:signal' && m.signalType === 'end', 'end');
console.log('PASS 4c end relay');
A.ws.close(); B.ws.close();
console.log('ALL WS TESTS PASSED');
