// End-to-end: maker -> checker(s) -> bank pop-up (OTP + MOP) -> webhook -> status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBank } from '../bank/server.js';
import { startNeobank } from '../neobank/server.js';
import { s2sRequest } from '../shared/security.js';

const SECRET = 'test-secret';
const base = 20000 + Math.floor(Math.random() * 20000);
const NB = `http://localhost:${base}`;
const BK = `http://localhost:${base + 1}`;

let bank;
let neobank;

test.before(async () => {
  bank = await startBank({ port: base + 1, publicUrl: BK, neobankUrl: NB, secret: SECRET, webhookRetryMs: 60000 });
  neobank = await startNeobank({ port: base, publicUrl: NB, bankUrl: BK, secret: SECRET });
});

test.after(async () => {
  await neobank.close();
  await bank.close();
});

// Cookie-keeping client, one per browser "user".
function client(baseUrl) {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
}

async function login(username, password = 'Pass@123') {
  const c = client(NB);
  const r = await c('POST', '/api/login', { username, password });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.body)}`);
  return c;
}

// Simulates the pop-up: read the session (and mock OTP) and submit a decision.
async function popupDecide(url, decision = 'APPROVE', { otp, remarks } = {}) {
  const popup = client(BK);
  const rid = new URL(url).searchParams.get('rid');
  const s = await popup('GET', `/popup/sessions/${rid}`);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const realOtp = /is (\d{6})/.exec(s.body.mockSms)[1];
  return popup('POST', `/popup/sessions/${rid}/decision`, { otp: otp ?? realOtp, decision, remarks });
}

async function authorize(checker, kind, id, decision, opts) {
  const s = await checker('POST', `/api/authorizations/${kind}/${id}/session`);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return popupDecide(s.body.url, decision, opts);
}

test('beneficiary: maker creates, one checker authorizes via bank pop-up', async () => {
  const maker = await login('acme.maker');
  const checker = await login('acme.checker3');
  const created = await maker('POST', '/api/beneficiaries', { name: 'Initech Ltd', accountNo: '123456789012', ifsc: 'ICIC0001234' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.status, 'PENDING_AUTHORIZATION');

  // Checker cannot create; maker cannot authorize.
  assert.equal((await checker('POST', '/api/beneficiaries', { name: 'X' })).status, 403);
  assert.equal((await maker('POST', `/api/authorizations/beneficiary/${created.body.id}/session`)).status, 403);

  const pending = await checker('GET', '/api/authorizations');
  assert.ok(pending.body.some((i) => i.id === created.body.id && i.canAuthorize));

  const r = await authorize(checker, 'beneficiary', created.body.id);
  assert.equal(r.body.status, 'AUTHORIZED');
  const list = await maker('GET', '/api/beneficiaries');
  assert.equal(list.body.find((b) => b.id === created.body.id).status, 'ACTIVE');
});

test('payment above ₹1L needs 1A + 1B (or 2A) per MOP; debits account once', async () => {
  const maker = await login('acme.maker');
  const a1 = await login('acme.checker1');
  const b1 = await login('acme.checker3');
  const before = (await maker('GET', '/api/account')).body;

  const p = await maker('POST', '/api/payments', { beneficiaryId: 'ben_seed1', amount: 250000, mode: 'RTGS', remarks: 'INV-42' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const held = (await maker('GET', '/api/account')).body;
  assert.equal(held.available, before.available - 250000);
  assert.equal(held.balance, before.balance);

  const first = await authorize(a1, 'payment', p.body.id);
  assert.equal(first.body.status, 'PENDING');
  // Same checker cannot sign twice.
  assert.equal((await a1('POST', `/api/authorizations/payment/${p.body.id}/session`)).status, 409);

  const second = await authorize(b1, 'payment', p.body.id);
  assert.equal(second.body.status, 'AUTHORIZED');
  assert.equal(second.body.execution.status, 'SUCCESS');

  const payments = (await maker('GET', '/api/payments')).body;
  const done = payments.find((x) => x.id === p.body.id);
  assert.equal(done.status, 'COMPLETED');
  assert.match(done.utr, /^UTR/);
  assert.equal(done.approvals.length, 2);
  const after = (await maker('GET', '/api/account')).body;
  assert.equal(after.balance, before.balance - 250000);
  assert.equal(after.available, before.available - 250000);
});

test('above ₹10L a group-B checker cannot sign twice-worth; B not needed after B signed', async () => {
  const maker = await login('acme.maker');
  const b1 = await login('acme.checker3');
  const p = await maker('POST', '/api/payments', { beneficiaryId: 'ben_seed1', amount: 1500000, mode: 'RTGS' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await authorize(b1, 'payment', p.body.id)).body.status, 'PENDING');
  const a1 = await login('acme.checker1');
  assert.equal((await authorize(a1, 'payment', p.body.id)).body.status, 'PENDING');
  const a2 = await login('acme.checker2');
  const last = await authorize(a2, 'payment', p.body.id);
  assert.equal(last.body.status, 'AUTHORIZED');
});

test('rejection releases earmarked funds; wrong OTP is refused and locks after 3 tries', async () => {
  const maker = await login('acme.maker');
  const a1 = await login('acme.checker1');
  const before = (await maker('GET', '/api/account')).body;
  const p = await maker('POST', '/api/payments', { beneficiaryId: 'ben_seed1', amount: 5000, mode: 'IMPS' });

  const s = await a1('POST', `/api/authorizations/payment/${p.body.id}/session`);
  const rid = new URL(s.body.url).searchParams.get('rid');
  const popup = client(BK);
  for (let i = 0; i < 2; i++) {
    const r = await popup('POST', `/popup/sessions/${rid}/decision`, { otp: '000000', decision: 'APPROVE' });
    assert.equal(r.status, 401);
  }
  const locked = await popup('POST', `/popup/sessions/${rid}/decision`, { otp: '000000', decision: 'APPROVE' });
  assert.match(locked.body.error, /locked|Incorrect/);
  assert.equal((await popup('GET', `/popup/sessions/${rid}`)).status, 410);

  // Rejecting without remarks is refused and does not burn the link.
  const s2 = await a1('POST', `/api/authorizations/payment/${p.body.id}/session`);
  const noRemarks = await popupDecide(s2.body.url, 'REJECT');
  assert.equal(noRemarks.status, 400);
  const rejected = await popupDecide(s2.body.url, 'REJECT', { remarks: 'Duplicate invoice' });
  assert.equal(rejected.body.status, 'REJECTED');

  const after = (await maker('GET', '/api/account')).body;
  assert.equal(after.available, before.available);
  const pay = (await maker('GET', '/api/payments')).body.find((x) => x.id === p.body.id);
  assert.equal(pay.status, 'REJECTED');
  assert.equal(pay.rejection.remarks, 'Duplicate invoice');
});

test('insufficient funds and invalid payment inputs are refused', async () => {
  const maker = await login('acme.maker');
  const huge = await maker('POST', '/api/payments', { beneficiaryId: 'ben_seed1', amount: 9e9, mode: 'NEFT' });
  assert.equal(huge.status, 422);
  assert.match(huge.body.error, /Insufficient/);
  assert.equal((await maker('POST', '/api/payments', { beneficiaryId: 'ben_seed1', amount: 1000, mode: 'RTGS' })).status, 400);
  assert.equal((await maker('POST', '/api/payments', { beneficiaryId: 'ben_seed1', amount: 10.123, mode: 'NEFT' })).status, 400);
});

test('onboarding: neobank admin submits client + MOP, bank admin approves, users can log in', async () => {
  const admin = client(NB);
  assert.equal((await admin('POST', '/api/admin/login', { username: 'nbadmin', password: 'Admin@123' })).status, 200);
  const bad = await admin('POST', '/api/admin/clients', {
    name: 'Bad Co',
    cin: 'U99999KA2021PTC000001',
    users: [
      { username: 'bad.maker', name: 'M', role: 'MAKER', password: 'Password1' },
      { username: 'bad.chk', name: 'C', role: 'CHECKER', group: 'A', password: 'Password1' },
    ],
    mopRules: [{ appliesTo: 'PAYMENT', minAmount: 0, maxAmount: '', combos: '2A' }],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /needs 2 checker/);

  const created = await admin('POST', '/api/admin/clients', {
    name: 'Wayne Exports',
    cin: 'U99999KA2021PTC000002',
    users: [
      { username: 'wayne.maker', name: 'Wayne Maker', role: 'MAKER', password: 'Password1' },
      { username: 'wayne.chk', name: 'Wayne Checker', role: 'CHECKER', group: 'A', password: 'Password1' },
    ],
    mopRules: [
      { appliesTo: 'BENEFICIARY', combos: '1A' },
      { appliesTo: 'PAYMENT', minAmount: 0, maxAmount: '', combos: '1A' },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const early = await client(NB)('POST', '/api/login', { username: 'wayne.maker', password: 'Password1' });
  assert.equal(early.status, 403);

  const bankAdmin = client(BK);
  assert.equal((await bankAdmin('POST', '/api/login', { username: 'bankadmin', password: 'Bank@123' })).status, 200);
  const approved = await bankAdmin('POST', `/api/clients/${created.body.id}/approve`, { openingBalance: 50000 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const maker = client(NB);
  assert.equal((await maker('POST', '/api/login', { username: 'wayne.maker', password: 'Password1' })).status, 200);
  assert.equal((await maker('GET', '/api/account')).body.balance, 50000);
});

test('S2S endpoints reject unsigned, tampered and replayed requests', async () => {
  const unsigned = await fetch(`${BK}/s2s/accounts/cli_acme`);
  assert.equal(unsigned.status, 401);
  const forged = await fetch(`${NB}/webhooks/bank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-timestamp': String(Date.now()), 'x-signature': 'deadbeef' },
    body: JSON.stringify({ id: 'evt_x', event: 'case.updated', data: {} }),
  });
  assert.equal(forged.status, 401);
  await assert.rejects(s2sRequest(BK, 'GET', '/s2s/accounts/cli_acme', undefined, 'wrong-secret'), /Bad signature/);
  assert.ok((await s2sRequest(BK, 'GET', '/s2s/accounts/cli_acme', undefined, SECRET)).accountNo);
});
