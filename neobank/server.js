// Neobank platform.
//  - Neobank Admin: onboards corporate clients (users + MOP) and submits them to the Bank.
//  - Corporate users: Makers create beneficiaries and payments; Checkers authorize them
//    through the Bank's authorization pop-up. Final status arrives via signed Bank webhooks.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, assert, HttpError } from '../shared/http.js';
import { createSessions, verifyPassword, hashPassword, requireSignature, s2sRequest, newId } from '../shared/security.js';
import { createStore, audit } from '../shared/store.js';
import { seedNeobank } from '../shared/seed.js';
import { parseCombos, validateMop, describeMop, isGroupNeeded } from '../shared/mop.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const PAYMENT_MODES = {
  IMPS: { min: 1, max: 500000 },
  NEFT: { min: 1, max: null },
  RTGS: { min: 200000, max: null },
};
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

export async function startNeobank({
  port = 3000,
  publicUrl = `http://localhost:${port}`,
  bankUrl = 'http://localhost:4000',
  bankPublicUrl = bankUrl,
  secret,
  dataFile = null,
} = {}) {
  assert(secret, 500, 'S2S secret required');
  const store = createStore(dataFile, seedNeobank);
  const db = store.data;
  const adminSessions = createSessions('nb_admin_sid');
  const userSessions = createSessions('nb_user_sid');
  const app = createApp({ name: 'neobank' });
  const bank = (method, p, body) => s2sRequest(bankUrl, method, p, body, secret);
  db.processedEvents ||= [];

  const findClient = (id) => db.clients.find((c) => c.id === id);
  const findUser = (id) => db.users.find((u) => u.id === id);
  const userName = (id) => findUser(id)?.name || id;
  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    group: u.group,
    status: u.status,
  });

  // ------------------------------------------------------------------ config
  app.get('/api/config', () => ({ bankUrl: bankPublicUrl, bankOrigin: new URL(bankPublicUrl).origin }));

  // ============================================================ NEOBANK ADMIN
  const requireAdmin = (ctx) => {
    const s = adminSessions.get(ctx);
    if (!s) throw new HttpError(401, 'Please log in');
    ctx.state.admin = s;
  };

  app.post('/api/admin/login', (ctx) => {
    const { username, password } = ctx.body;
    const admin = db.admins.find((a) => a.username === username);
    if (!admin || !verifyPassword(password, admin.passwordHash)) throw new HttpError(401, 'Invalid credentials');
    adminSessions.create(ctx.res, { id: admin.id, name: admin.name, username: admin.username });
    audit(store, admin.username, 'ADMIN_LOGIN');
    store.save();
    return { name: admin.name };
  });

  app.post('/api/admin/logout', (ctx) => {
    adminSessions.destroy(ctx);
    return { ok: true };
  });

  app.get('/api/admin/me', requireAdmin, (ctx) => ctx.state.admin);

  app.get('/api/admin/clients', requireAdmin, () =>
    db.clients.map((c) => ({
      id: c.id,
      name: c.name,
      cin: c.cin,
      accountNo: c.accountNo || null,
      status: c.status,
      remarks: c.remarks || null,
      mop: describeMop(c.mop),
      users: db.users.filter((u) => u.clientId === c.id).map(publicUser),
      createdAt: c.createdAt,
    })),
  );

  // Body: { name, cin, users: [{ username, name, role, group, password }],
  //         mopRules: [{ appliesTo, minAmount, maxAmount, combos: "1A + 1B | 2A" }] }
  app.post('/api/admin/clients', requireAdmin, async (ctx) => {
    const name = String(ctx.body.name || '').trim();
    const cin = String(ctx.body.cin || '').trim().toUpperCase();
    assert(name.length >= 3, 400, 'Company name is required');
    assert(/^[A-Z0-9]{8,21}$/.test(cin), 400, 'CIN must be 8–21 letters/digits');
    assert(!db.clients.some((c) => c.cin === cin), 409, 'A client with this CIN already exists');

    const users = Array.isArray(ctx.body.users) ? ctx.body.users : [];
    assert(users.some((u) => u.role === 'MAKER'), 400, 'At least one Maker is required');
    assert(users.some((u) => u.role === 'CHECKER'), 400, 'At least one Checker is required');
    const seen = new Set();
    for (const u of users) {
      assert(USERNAME_RE.test(u.username || ''), 400, `Invalid username "${u.username || ''}"`);
      assert(!seen.has(u.username) && !db.users.some((x) => x.username === u.username), 409, `Username ${u.username} is taken`);
      seen.add(u.username);
      assert(String(u.name || '').trim(), 400, 'Every user needs a name');
      assert(['MAKER', 'CHECKER'].includes(u.role), 400, 'Role must be MAKER or CHECKER');
      if (u.role === 'CHECKER') assert(/^[A-Z]$/.test(u.group || ''), 400, `Checker ${u.username} needs a group (A–Z)`);
      assert(String(u.password || '').length >= 8, 400, `Password for ${u.username} must be at least 8 characters`);
    }

    let mop;
    try {
      const rules = (ctx.body.mopRules || []).map((r) => ({
        appliesTo: r.appliesTo,
        minAmount: r.appliesTo === 'PAYMENT' ? Number(r.minAmount || 0) : 0,
        maxAmount: r.appliesTo === 'PAYMENT' && r.maxAmount !== '' && r.maxAmount != null ? Number(r.maxAmount) : null,
        anyOf: parseCombos(r.combos),
      }));
      mop = { rules };
      const groupSizes = {};
      for (const u of users) if (u.role === 'CHECKER') groupSizes[u.group] = (groupSizes[u.group] || 0) + 1;
      validateMop(mop, groupSizes);
    } catch (err) {
      throw new HttpError(400, err.message);
    }

    const client = {
      id: newId('cli'),
      name,
      cin,
      mop,
      status: 'PENDING_BANK_APPROVAL',
      createdBy: ctx.state.admin.username,
      createdAt: new Date().toISOString(),
    };
    const newUsers = users.map((u) => ({
      id: newId('usr'),
      clientId: client.id,
      username: u.username,
      name: String(u.name).trim(),
      role: u.role,
      group: u.role === 'CHECKER' ? u.group : null,
      status: 'INACTIVE',
      passwordHash: hashPassword(u.password),
    }));

    await bank('POST', '/s2s/clients', {
      id: client.id,
      name,
      cin,
      mop,
      authorizers: newUsers.filter((u) => u.role === 'CHECKER').map((u) => ({ userId: u.id, name: u.name, group: u.group })),
    });

    db.clients.push(client);
    db.users.push(...newUsers);
    audit(store, ctx.state.admin.username, 'CLIENT_ONBOARDED', { clientId: client.id });
    store.save();
    return { id: client.id, status: client.status };
  });

  app.get('/api/admin/transactions', requireAdmin, () => {
    const clientName = (id) => findClient(id)?.name;
    return {
      payments: db.payments.slice().reverse().map((p) => ({ ...p, clientName: clientName(p.clientId), createdByName: userName(p.createdBy) })),
      beneficiaries: db.beneficiaries
        .slice()
        .reverse()
        .map((b) => ({ ...b, clientName: clientName(b.clientId), createdByName: userName(b.createdBy) })),
    };
  });

  app.get('/api/admin/audit', requireAdmin, () => db.audit.slice(-200).reverse());

  // ========================================================== CORPORATE USERS
  const requireUser = (ctx) => {
    const s = userSessions.get(ctx);
    const user = s && findUser(s.id);
    if (!user || user.status !== 'ACTIVE') throw new HttpError(401, 'Please log in');
    ctx.state.user = user;
    ctx.state.client = findClient(user.clientId);
  };
  const requireRole = (role) => (ctx) => {
    if (ctx.state.user.role !== role) throw new HttpError(403, `Only a ${role.toLowerCase()} can do this`);
  };

  app.post('/api/login', (ctx) => {
    const { username, password } = ctx.body;
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) throw new HttpError(401, 'Invalid credentials');
    const client = findClient(user.clientId);
    assert(client.status === 'ACTIVE', 403, 'Your company is pending bank approval');
    assert(user.status === 'ACTIVE', 403, 'Your user is not active');
    userSessions.create(ctx.res, { id: user.id });
    audit(store, user.username, 'USER_LOGIN');
    store.save();
    return publicUser(user);
  });

  app.post('/api/logout', (ctx) => {
    userSessions.destroy(ctx);
    return { ok: true };
  });

  app.get('/api/me', requireUser, (ctx) => ({
    user: publicUser(ctx.state.user),
    client: { id: ctx.state.client.id, name: ctx.state.client.name, accountNo: ctx.state.client.accountNo },
    mop: describeMop(ctx.state.client.mop),
  }));

  app.get('/api/account', requireUser, (ctx) => bank('GET', `/s2s/accounts/${ctx.state.client.id}`));

  // ------------------------------------------------------------ beneficiaries
  const withNames = (x) => ({ ...x, createdByName: userName(x.createdBy) });

  app.get('/api/beneficiaries', requireUser, (ctx) =>
    db.beneficiaries.filter((b) => b.clientId === ctx.state.client.id).reverse().map(withNames),
  );

  app.post('/api/beneficiaries', requireUser, requireRole('MAKER'), async (ctx) => {
    const { user, client } = ctx.state;
    const name = String(ctx.body.name || '').trim();
    const accountNo = String(ctx.body.accountNo || '').trim();
    const ifsc = String(ctx.body.ifsc || '').trim().toUpperCase();
    const nickname = String(ctx.body.nickname || '').trim();
    assert(name.length >= 3, 400, 'Beneficiary name is required');
    assert(ACCOUNT_RE.test(accountNo), 400, 'Account number must be 9–18 digits');
    assert(IFSC_RE.test(ifsc), 400, 'Invalid IFSC code');
    assert(
      !db.beneficiaries.some(
        (b) => b.clientId === client.id && b.accountNo === accountNo && b.ifsc === ifsc && b.status !== 'REJECTED',
      ),
      409,
      'This beneficiary already exists',
    );
    const ben = {
      id: newId('ben'),
      clientId: client.id,
      name,
      accountNo,
      ifsc,
      nickname,
      status: 'PENDING_AUTHORIZATION',
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      approvals: [],
    };
    const c = await bank('POST', '/s2s/cases', {
      clientId: client.id,
      type: 'BENEFICIARY',
      refId: ben.id,
      makerId: user.id,
      makerName: user.name,
      details: { name, accountNo, ifsc, nickname },
    });
    ben.caseId = c.id;
    ben.requirement = c.requirement;
    ben.anyOf = c.anyOf;
    db.beneficiaries.push(ben);
    audit(store, user.username, 'BENEFICIARY_CREATED', { id: ben.id });
    store.save();
    return withNames(ben);
  });

  // ----------------------------------------------------------------- payments
  app.get('/api/payments', requireUser, (ctx) =>
    db.payments.filter((p) => p.clientId === ctx.state.client.id).reverse().map(withNames),
  );

  app.post('/api/payments', requireUser, requireRole('MAKER'), async (ctx) => {
    const { user, client } = ctx.state;
    const ben = db.beneficiaries.find((b) => b.id === ctx.body.beneficiaryId && b.clientId === client.id);
    assert(ben && ben.status === 'ACTIVE', 400, 'Choose an authorized beneficiary');
    const amount = Number(ctx.body.amount);
    assert(
      Number.isFinite(amount) && amount > 0 && Math.abs(Math.round(amount * 100) - amount * 100) < 1e-6,
      400,
      'Enter a valid amount (max 2 decimals)',
    );
    const mode = ctx.body.mode;
    const limits = PAYMENT_MODES[mode];
    assert(limits, 400, 'Mode must be IMPS, NEFT or RTGS');
    assert(amount >= limits.min, 400, `${mode} minimum is ₹${limits.min.toLocaleString('en-IN')}`);
    assert(limits.max === null || amount <= limits.max, 400, `${mode} maximum is ₹${limits.max?.toLocaleString('en-IN')}`);
    const remarks = String(ctx.body.remarks || '').trim().slice(0, 60);

    const payment = {
      id: newId('pay'),
      clientId: client.id,
      beneficiaryId: ben.id,
      beneficiaryName: ben.name,
      beneficiaryAccount: ben.accountNo,
      ifsc: ben.ifsc,
      amount,
      mode,
      remarks,
      status: 'PENDING_AUTHORIZATION',
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      approvals: [],
    };
    const c = await bank('POST', '/s2s/cases', {
      clientId: client.id,
      type: 'PAYMENT',
      refId: payment.id,
      makerId: user.id,
      makerName: user.name,
      amount,
      details: { beneficiaryName: ben.name, accountNo: ben.accountNo, ifsc: ben.ifsc, mode, remarks },
    });
    payment.caseId = c.id;
    payment.requirement = c.requirement;
    payment.anyOf = c.anyOf;
    db.payments.push(payment);
    audit(store, user.username, 'PAYMENT_CREATED', { id: payment.id, amount });
    store.save();
    return withNames(payment);
  });

  // ----------------------------------------------------------- authorizations
  const KINDS = { payment: 'payments', beneficiary: 'beneficiaries' };
  const canAuthorize = (item, user) =>
    item.status === 'PENDING_AUTHORIZATION' &&
    item.createdBy !== user.id &&
    !item.approvals.some((a) => a.userId === user.id) &&
    isGroupNeeded(item.anyOf || [], item.approvals, user.group);

  app.get('/api/authorizations', requireUser, requireRole('CHECKER'), (ctx) => {
    const { user, client } = ctx.state;
    const pending = (list, kind) =>
      list
        .filter((x) => x.clientId === client.id && x.status === 'PENDING_AUTHORIZATION')
        .map((x) => ({ kind, ...withNames(x), canAuthorize: canAuthorize(x, user) }));
    return [...pending(db.payments, 'payment'), ...pending(db.beneficiaries, 'beneficiary')].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  });

  // Starts a Bank authorization session; the browser opens the returned URL in a pop-up.
  app.post('/api/authorizations/:kind/:id/session', requireUser, requireRole('CHECKER'), async (ctx) => {
    const collection = KINDS[ctx.params.kind];
    assert(collection, 404, 'Unknown item type');
    const { user, client } = ctx.state;
    const item = db[collection].find((x) => x.id === ctx.params.id && x.clientId === client.id);
    assert(item, 404, 'Not found');
    assert(item.status === 'PENDING_AUTHORIZATION', 409, `Already ${item.status}`);
    assert(item.createdBy !== user.id, 403, 'You cannot authorize your own transaction');
    const session = await bank('POST', `/s2s/cases/${item.caseId}/sessions`, { userId: user.id });
    audit(store, user.username, 'AUTH_SESSION_STARTED', { id: item.id });
    store.save();
    return session;
  });

  // ================================================================ WEBHOOKS
  function applyCase(c) {
    const collection = c.type === 'PAYMENT' ? db.payments : db.beneficiaries;
    const item = collection.find((x) => x.id === c.refId && x.caseId === c.id);
    if (!item) return;
    item.approvals = c.approvals;
    item.rejection = c.rejection;
    item.updatedAt = c.updatedAt;
    if (c.status === 'REJECTED') item.status = 'REJECTED';
    else if (c.status === 'AUTHORIZED' && c.type === 'BENEFICIARY') item.status = 'ACTIVE';
    else if (c.status === 'AUTHORIZED' && c.type === 'PAYMENT') {
      item.status = c.execution?.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED';
      item.utr = c.execution?.utr;
      item.failureReason = c.execution?.reason;
    }
  }

  app.post('/webhooks/bank', requireSignature(secret), (ctx) => {
    const { id, event, data } = ctx.body;
    if (db.processedEvents.includes(id)) return { ok: true, duplicate: true };
    if (event === 'client.status') {
      const client = findClient(data.clientId);
      if (client) {
        client.status = data.status;
        client.remarks = data.remarks;
        if (data.accountNo) client.accountNo = data.accountNo;
        if (data.status === 'ACTIVE') {
          for (const u of db.users) if (u.clientId === client.id) u.status = 'ACTIVE';
        }
      }
    } else if (event === 'case.updated') {
      applyCase(data);
    }
    db.processedEvents.push(id);
    if (db.processedEvents.length > 1000) db.processedEvents.splice(0, 500);
    audit(store, 'bank', `WEBHOOK_${event}`, { id });
    store.save();
    return { ok: true };
  });

  // ------------------------------------------------------------------ static
  app.static('/shared', path.join(here, '../shared/public'));
  app.static('/', path.join(here, 'public'));

  const server = await app.listen(port);
  return { server, store, url: publicUrl, close: () => new Promise((r) => server.close(r)) };
}
