// Mock Bank Portal.
//  - Bank Admin UI: approve corporate onboarding (and the client's MOP), fund accounts,
//    view authorization cases and the audit trail.
//  - Authorization pop-up: the only place a transaction can be authorized. Opened
//    from the Neobank platform by a client Checker; enforces OTP + MOP.
//  - S2S API used by the Neobank backend (HMAC-signed), and signed webhooks back.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, assert, HttpError } from '../shared/http.js';
import {
  createSessions,
  verifyPassword,
  requireSignature,
  s2sRequest,
  newId,
  randomToken,
  generateOtp,
  safeEqual,
} from '../shared/security.js';
import { createStore, audit } from '../shared/store.js';
import { seedBank } from '../shared/seed.js';
import { findRule, isSatisfied, isGroupNeeded, formatCombos, validateMop, describeMop, TXN_TYPES } from '../shared/mop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;

const money = (n) => Math.round(n * 100) / 100;

export async function startBank({
  port = 4000,
  publicUrl = `http://localhost:${port}`,
  neobankUrl = 'http://localhost:3000',
  secret,
  dataFile = null,
  webhookRetryMs = 5000,
} = {}) {
  assert(secret, 500, 'S2S secret required');
  const store = createStore(dataFile, seedBank);
  const db = store.data;
  const sessions = createSessions('bank_sid');
  const app = createApp({ name: 'bank' });
  const neobankOrigin = new URL(neobankUrl).origin;

  // ------------------------------------------------------------------ helpers
  const findClient = (id) => db.clients.find((c) => c.id === id);
  const findAccount = (clientId) => db.accounts.find((a) => a.clientId === clientId);
  const findCase = (id) => db.cases.find((c) => c.id === id);

  function publicCase(c) {
    return {
      id: c.id,
      clientId: c.clientId,
      type: c.type,
      refId: c.refId,
      amount: c.amount,
      details: c.details,
      status: c.status,
      requirement: formatCombos(c.anyOf),
      anyOf: c.anyOf,
      approvals: c.approvals,
      rejection: c.rejection || null,
      execution: c.execution || null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  function postLedger(account, type, amount, narration, ref) {
    account.balance = money(account.balance + (type === 'CREDIT' ? amount : -amount));
    const entry = {
      id: newId('txn'),
      accountNo: account.accountNo,
      type,
      amount,
      balanceAfter: account.balance,
      narration,
      ref,
      at: new Date().toISOString(),
    };
    db.ledger.push(entry);
    return entry;
  }

  // Webhooks are queued in an outbox and retried until the Neobank acknowledges.
  // Deliveries are serialized so the retry timer and live events never race.
  let deliveryChain = Promise.resolve();
  function deliverOutbox() {
    deliveryChain = deliveryChain.then(deliverPending).catch((err) => console.error('[bank] outbox', err));
    return deliveryChain;
  }

  async function deliverPending() {
    for (const msg of db.outbox.filter((m) => !m.deliveredAt)) {
      try {
        await s2sRequest(neobankUrl, 'POST', '/webhooks/bank', msg.payload, secret);
        msg.deliveredAt = new Date().toISOString();
      } catch (err) {
        msg.attempts = (msg.attempts || 0) + 1;
        msg.lastError = err.message;
      }
    }
    db.outbox = db.outbox.filter((m) => !m.deliveredAt || Date.now() - Date.parse(m.deliveredAt) < 3600_000);
    store.save();
  }

  async function emit(event, data) {
    db.outbox.push({ id: newId('evt'), payload: { id: newId('evt'), event, data }, createdAt: new Date().toISOString() });
    store.save();
    await deliverOutbox();
  }

  const retryTimer = setInterval(deliverOutbox, webhookRetryMs);
  retryTimer.unref();

  // ------------------------------------------------------------ admin auth
  const requireAdmin = (ctx) => {
    const s = sessions.get(ctx);
    if (!s) throw new HttpError(401, 'Please log in');
    ctx.state.admin = s;
  };

  app.post('/api/login', (ctx) => {
    const { username, password } = ctx.body;
    const admin = db.admins.find((a) => a.username === username);
    if (!admin || !verifyPassword(password, admin.passwordHash)) throw new HttpError(401, 'Invalid credentials');
    sessions.create(ctx.res, { id: admin.id, name: admin.name, username: admin.username });
    audit(store, admin.username, 'LOGIN');
    store.save();
    return { name: admin.name };
  });

  app.post('/api/logout', (ctx) => {
    sessions.destroy(ctx);
    return { ok: true };
  });

  app.get('/api/me', requireAdmin, (ctx) => ctx.state.admin);

  // --------------------------------------------------------- admin: clients
  app.get('/api/clients', requireAdmin, () =>
    db.clients.map((c) => ({
      id: c.id,
      name: c.name,
      cin: c.cin,
      status: c.status,
      accountNo: c.accountNo || null,
      mop: describeMop(c.mop),
      authorizers: c.authorizers,
      account: findAccount(c.id) || null,
      submittedAt: c.submittedAt,
      remarks: c.remarks || null,
    })),
  );

  app.post('/api/clients/:id/approve', requireAdmin, async (ctx) => {
    const client = findClient(ctx.params.id);
    assert(client, 404, 'Client not found');
    assert(client.status === 'PENDING_APPROVAL', 409, `Client is ${client.status}`);
    const opening = Number(ctx.body.openingBalance || 0);
    assert(Number.isFinite(opening) && opening >= 0, 400, 'Invalid opening balance');
    client.status = 'ACTIVE';
    client.accountNo = `5020${String(Date.now()).slice(-10)}`;
    client.decidedAt = new Date().toISOString();
    client.decidedBy = ctx.state.admin.username;
    const account = { accountNo: client.accountNo, clientId: client.id, balance: 0, held: 0 };
    db.accounts.push(account);
    if (opening > 0) postLedger(account, 'CREDIT', money(opening), 'Opening balance');
    audit(store, ctx.state.admin.username, 'CLIENT_APPROVED', { clientId: client.id });
    await emit('client.status', { clientId: client.id, status: 'ACTIVE', accountNo: client.accountNo });
    return { ok: true, accountNo: client.accountNo };
  });

  app.post('/api/clients/:id/reject', requireAdmin, async (ctx) => {
    const client = findClient(ctx.params.id);
    assert(client, 404, 'Client not found');
    assert(client.status === 'PENDING_APPROVAL', 409, `Client is ${client.status}`);
    const remarks = String(ctx.body.remarks || '').trim();
    assert(remarks, 400, 'Remarks are required when rejecting');
    client.status = 'REJECTED';
    client.remarks = remarks;
    client.decidedAt = new Date().toISOString();
    client.decidedBy = ctx.state.admin.username;
    audit(store, ctx.state.admin.username, 'CLIENT_REJECTED', { clientId: client.id, remarks });
    await emit('client.status', { clientId: client.id, status: 'REJECTED', remarks });
    return { ok: true };
  });

  app.post('/api/accounts/:accountNo/credit', requireAdmin, (ctx) => {
    const account = db.accounts.find((a) => a.accountNo === ctx.params.accountNo);
    assert(account, 404, 'Account not found');
    const amount = money(Number(ctx.body.amount));
    assert(Number.isFinite(amount) && amount > 0, 400, 'Amount must be positive');
    const entry = postLedger(account, 'CREDIT', amount, String(ctx.body.narration || 'Funds credited by bank'));
    audit(store, ctx.state.admin.username, 'ACCOUNT_CREDITED', { accountNo: account.accountNo, amount });
    store.save();
    return entry;
  });

  app.get('/api/cases', requireAdmin, () =>
    db.cases
      .slice()
      .reverse()
      .map((c) => ({ ...publicCase(c), clientName: findClient(c.clientId)?.name })),
  );

  app.get('/api/audit', requireAdmin, () => db.audit.slice(-200).reverse());

  // ------------------------------------------------------------ S2S (Neobank)
  const s2s = requireSignature(secret);

  // Neobank submits a newly onboarded corporate client with its MOP.
  app.post('/s2s/clients', s2s, (ctx) => {
    const { id, name, cin, mop, authorizers } = ctx.body;
    assert(id && name && cin, 400, 'id, name and cin are required');
    assert(!findClient(id), 409, 'Client already submitted');
    assert(Array.isArray(authorizers) && authorizers.length, 400, 'At least one authorizer is required');
    const groupSizes = {};
    for (const a of authorizers) groupSizes[a.group] = (groupSizes[a.group] || 0) + 1;
    try {
      validateMop(mop, groupSizes);
    } catch (err) {
      throw new HttpError(422, err.message);
    }
    db.clients.push({
      id,
      name,
      cin,
      mop,
      authorizers: authorizers.map(({ userId, name: n, group }) => ({ userId, name: n, group })),
      status: 'PENDING_APPROVAL',
      submittedAt: new Date().toISOString(),
    });
    audit(store, 'neobank', 'CLIENT_SUBMITTED', { clientId: id });
    store.save();
    return { status: 'PENDING_APPROVAL' };
  });

  // Neobank registers a maker-initiated transaction that needs authorization.
  app.post('/s2s/cases', s2s, (ctx) => {
    const { clientId, type, refId, makerId, makerName, details } = ctx.body;
    const client = findClient(clientId);
    assert(client && client.status === 'ACTIVE', 409, 'Client is not active at the bank');
    assert(TXN_TYPES.includes(type), 400, 'Invalid transaction type');
    assert(refId && makerId, 400, 'refId and makerId are required');

    const existing = db.cases.find((c) => c.clientId === clientId && c.type === type && c.refId === refId);
    if (existing) return publicCase(existing); // idempotent retry

    const amount = type === 'PAYMENT' ? money(Number(ctx.body.amount)) : 0;
    if (type === 'PAYMENT') assert(Number.isFinite(amount) && amount > 0, 400, 'Invalid amount');
    const rule = findRule(client.mop, type, amount);
    assert(rule, 422, 'No MOP rule covers this transaction. Contact your relationship manager.');

    if (type === 'PAYMENT') {
      const account = findAccount(clientId);
      const available = money(account.balance - account.held);
      assert(amount <= available, 422, `Insufficient available balance (₹${available.toLocaleString('en-IN')})`);
      account.held = money(account.held + amount); // earmark funds until authorized or rejected
    }

    const now = new Date().toISOString();
    const c = {
      id: newId('case'),
      clientId,
      type,
      refId,
      makerId,
      makerName,
      amount,
      details: details || {},
      anyOf: rule.anyOf,
      approvals: [],
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    db.cases.push(c);
    audit(store, `neobank:${makerId}`, 'CASE_CREATED', { caseId: c.id, type, amount });
    store.save();
    return publicCase(c);
  });

  function checkEligible(c, userId) {
    assert(c.status === 'PENDING', 409, `Transaction is already ${c.status}`);
    const client = findClient(c.clientId);
    const authorizer = client?.authorizers.find((a) => a.userId === userId);
    assert(authorizer, 403, 'You are not an authorized signatory for this client');
    assert(userId !== c.makerId, 403, 'Maker cannot authorize their own transaction');
    assert(!c.approvals.some((a) => a.userId === userId), 409, 'You have already authorized this transaction');
    assert(
      isGroupNeeded(c.anyOf, c.approvals, authorizer.group),
      409,
      `No further approval from Group ${authorizer.group} is required by the MOP`,
    );
    return authorizer;
  }

  // Neobank asks for a single-use authorization session for a specific checker.
  app.post('/s2s/cases/:id/sessions', s2s, (ctx) => {
    const c = findCase(ctx.params.id);
    assert(c, 404, 'Case not found');
    checkEligible(c, ctx.body.userId);
    const s = {
      rid: randomToken(),
      caseId: c.id,
      userId: ctx.body.userId,
      otp: generateOtp(), // MOCK: a real bank sends this to the signatory's registered mobile
      attempts: 0,
      used: false,
      expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
    };
    db.sessions = db.sessions.filter((x) => !x.used && x.expiresAt > Date.now());
    db.sessions.push(s);
    store.save();
    return { url: `${publicUrl}/authorize.html?rid=${encodeURIComponent(s.rid)}`, expiresAt: s.expiresAt };
  });

  app.get('/s2s/cases/:id', s2s, (ctx) => {
    const c = findCase(ctx.params.id);
    assert(c, 404, 'Case not found');
    return publicCase(c);
  });

  app.get('/s2s/accounts/:clientId', s2s, (ctx) => {
    const account = findAccount(ctx.params.clientId);
    assert(account, 404, 'Account not found');
    return {
      ...account,
      available: money(account.balance - account.held),
      ledger: db.ledger.filter((l) => l.accountNo === account.accountNo).slice(-25).reverse(),
    };
  });

  // --------------------------------------------------- authorization pop-up
  function loadSession(rid) {
    const s = db.sessions.find((x) => x.rid === rid);
    assert(s, 404, 'This authorization link is invalid');
    assert(!s.used, 410, 'This authorization link has already been used');
    assert(s.expiresAt > Date.now(), 410, 'This authorization link has expired. Please start again.');
    return s;
  }

  app.get('/popup/sessions/:rid', (ctx) => {
    const s = loadSession(ctx.params.rid);
    const c = findCase(s.caseId);
    const client = findClient(c.clientId);
    const authorizer = client.authorizers.find((a) => a.userId === s.userId);
    return {
      neobankOrigin,
      expiresAt: s.expiresAt,
      mockSms: `Your Bank OTP to authorize ${c.type.toLowerCase()} ${c.id} is ${s.otp}. Do not share it.`,
      authorizer,
      client: { name: client.name, accountNo: client.accountNo },
      transaction: {
        ...publicCase(c),
        makerName: c.makerName,
      },
    };
  });

  app.post('/popup/sessions/:rid/decision', async (ctx) => {
    const s = loadSession(ctx.params.rid);
    const { otp, decision } = ctx.body;
    const remarks = String(ctx.body.remarks || '').trim();
    assert(decision === 'APPROVE' || decision === 'REJECT', 400, 'Decision must be APPROVE or REJECT');
    assert(decision === 'APPROVE' || remarks, 400, 'Remarks are required when rejecting');
    if (!safeEqual(String(otp || ''), s.otp)) {
      s.attempts += 1;
      if (s.attempts >= MAX_OTP_ATTEMPTS) s.used = true;
      store.save();
      throw new HttpError(401, s.used ? 'Too many wrong OTPs. This link is now locked.' : 'Incorrect OTP');
    }
    s.used = true;

    const c = findCase(s.caseId);
    const authorizer = checkEligible(c, s.userId); // re-check: state may have changed since the pop-up opened
    const now = new Date().toISOString();
    const account = findAccount(c.clientId);

    if (decision === 'REJECT') {
      c.status = 'REJECTED';
      c.rejection = { userId: s.userId, name: authorizer.name, group: authorizer.group, remarks, at: now };
      if (c.type === 'PAYMENT') account.held = money(account.held - c.amount);
    } else {
      c.approvals.push({ userId: s.userId, name: authorizer.name, group: authorizer.group, at: now });
      if (isSatisfied(c.anyOf, c.approvals)) {
        c.status = 'AUTHORIZED';
        if (c.type === 'PAYMENT') {
          account.held = money(account.held - c.amount);
          if (account.balance >= c.amount) {
            const d = c.details;
            const entry = postLedger(account, 'DEBIT', c.amount, `${d.mode} to ${d.beneficiaryName} ${d.remarks || ''}`.trim(), c.refId);
            c.execution = { status: 'SUCCESS', utr: `UTR${Date.now()}${entry.id.slice(-4).toUpperCase()}`, at: now };
          } else {
            c.execution = { status: 'FAILED', reason: 'Insufficient balance at execution', at: now };
          }
        }
      }
    }
    c.updatedAt = now;
    audit(store, `signatory:${s.userId}`, `CASE_${decision}`, { caseId: c.id, status: c.status });
    await emit('case.updated', publicCase(c));
    return { status: c.status, approvals: c.approvals.length, execution: c.execution || null, refId: c.refId };
  });

  // ------------------------------------------------------------------ static
  app.static('/shared', path.join(here, '../shared/public'));
  app.static('/', path.join(here, 'public'));

  const server = await app.listen(port);
  return {
    server,
    store,
    url: publicUrl,
    close: () => {
      clearInterval(retryTimer);
      return new Promise((r) => server.close(r));
    },
  };
}
