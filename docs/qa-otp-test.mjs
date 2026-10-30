// Phase 0 OTP regression suite (roadmap 0.1: server is the ONLY OTP path).
// Expects TWO servers already running, neither with SMTP configured:
//   DEMO_OTP (default http://127.0.0.1:3000) with CHITTHI_DEMO_OTP=true
//   NOFLAG   (default http://127.0.0.1:3002) without CHITTHI_DEMO_OTP
// Run: node docs/qa-otp-test.mjs
const DEMO_OTP = process.env.QA_OTP_URL || 'http://127.0.0.1:3000';
const NOFLAG = process.env.QA_OTP_NOFLAG_URL || 'http://127.0.0.1:3002';

let passed = 0;
const ok = (label) => { passed++; console.log('PASS', label); };

const post = async (base, path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

const runId = Date.now();
const email = `qa_otp_${runId}@example.com`;

// O1: client-smuggled code is ignored (server generates its own)
const send1 = await post(DEMO_OTP, '/api/auth/send-2fa-code', { email, name: 'QA', code: '000000' });
if (send1.status !== 200 || !send1.json.success) throw new Error('O1 send failed: ' + JSON.stringify(send1));
if (send1.json.delivery !== 'demo') throw new Error('O1 expected demo delivery (no SMTP in test env)');
const smuggled = await post(DEMO_OTP, '/api/auth/verify-2fa-code', { email, code: '000000' });
if (smuggled.json.valid) throw new Error('O1 smuggled client code was accepted!');
ok('O1 client-supplied code ignored');

// O2: the demo-gated response carries the server code, and NO "2FA" copy leaks
const serverCode = send1.json.code;
if (!/^\d{6}$/.test(serverCode || '')) throw new Error('O2 demo response missing server code (is CHITTHI_DEMO_OTP=true on this server?)');
if (/2FA/.test(JSON.stringify(send1.json))) throw new Error('O2 response still contains "2FA" copy');
ok('O2 demo code returned only behind the env gate; copy renamed');

// O3: wrong code rejected
const wrong = serverCode === '123456' ? '123457' : '123456';
const wrongRes = await post(DEMO_OTP, '/api/auth/verify-2fa-code', { email, code: wrong });
if (wrongRes.json.valid) throw new Error('O3 wrong code accepted');
ok('O3 wrong code rejected');

// O4: correct server code accepted exactly once (consumed on use)
const good = await post(DEMO_OTP, '/api/auth/verify-2fa-code', { email, code: serverCode });
if (!good.json.valid) throw new Error('O4 correct code rejected: ' + JSON.stringify(good.json));
const replay = await post(DEMO_OTP, '/api/auth/verify-2fa-code', { email, code: serverCode });
if (replay.json.valid) throw new Error('O4 code verified twice — not consumed');
ok('O4 correct code accepted once, replay rejected');

// O5: rate limit — 5 requests/hour per email, 6th is 429
const rlEmail = `qa_rl_${runId}@example.com`;
for (let i = 0; i < 5; i++) {
  const r = await post(DEMO_OTP, '/api/auth/send-2fa-code', { email: rlEmail, name: 'RL' });
  if (r.status !== 200) throw new Error(`O5 request ${i + 1} expected 200, got ${r.status}`);
}
const sixth = await post(DEMO_OTP, '/api/auth/send-2fa-code', { email: rlEmail, name: 'RL' });
if (sixth.status !== 429) throw new Error(`O5 6th request expected 429, got ${sixth.status}`);
ok('O5 rate limit: 6th request in an hour -> 429');

// O6 (NOFLAG server): without CHITTHI_DEMO_OTP the code is never disclosed
const nfEmail = `qa_nf_${runId}@example.com`;
const nf = await post(NOFLAG, '/api/auth/send-2fa-code', { email: nfEmail, name: 'NF' });
if (nf.status !== 200 || !nf.json.success) throw new Error('O6 send failed on no-flag server');
if ('code' in (nf.json || {})) throw new Error('O6 code leaked in response without the demo flag!');
if (nf.json.delivery !== 'demo') throw new Error('O6 expected honest demo delivery marker');
ok('O6 code withheld when CHITTHI_DEMO_OTP is not set');

console.log(`ALL OTP TESTS PASSED (${passed} checks)`);
