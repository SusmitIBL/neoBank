import { api, h, $, inr, dt, badge, toast, table, tabs, onSubmit } from '/shared/ui.js';

let me;
let config;
let current = 'dashboard';
let tabBar;

async function init() {
  try {
    [me, config] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/config')]);
  } catch {
    location.href = '/';
    return;
  }
  const { user, client } = me;
  $('#who').textContent = `${user.name} · ${user.role === 'CHECKER' ? `Checker (Group ${user.group})` : 'Maker'} · ${client.name}`;
  $('#logout').onclick = async () => {
    await api('POST', '/api/logout');
    location.href = '/';
  };

  const names = { dashboard: 'Dashboard', beneficiaries: 'Beneficiaries', payments: 'Payments' };
  if (user.role === 'CHECKER') names.authorizations = 'Pending authorization';
  names.mop = 'Mode of Operation';
  tabBar = tabs($('#tabs'), names, (key) => {
    current = key;
    render();
  });
  tabBar.select(user.role === 'CHECKER' ? 'authorizations' : 'dashboard');

  // Result from the Bank's authorization pop-up. Only trust messages from the Bank origin;
  // the authoritative status arrives server-side via the signed webhook.
  window.addEventListener('message', (e) => {
    if (e.origin !== config.bankOrigin || e.data?.type !== 'bank-authorization-complete') return;
    const { status } = e.data;
    toast(status === 'PENDING' ? 'Your authorization is recorded. More approvals are needed as per MOP.' : `Transaction ${status.toLowerCase()}.`);
    render();
  });
}

async function refreshPendingCount() {
  if (me.user.role !== 'CHECKER') return;
  const items = await api('GET', '/api/authorizations');
  const n = items.filter((i) => i.canAuthorize).length;
  const btn = tabBar.buttons.authorizations;
  btn.replaceChildren('Pending authorization', n ? h('span', { class: 'count' }, n) : '');
}

async function render() {
  const view = $('#view');
  try {
    const content = await VIEWS[current]();
    view.replaceChildren(content);
    refreshPendingCount().catch(() => {});
  } catch (err) {
    if (err.status === 401) location.href = '/';
    view.replaceChildren(h('div', { class: 'notice bad' }, err.message));
  }
}

function approvalsCell(item) {
  const got = (item.approvals || []).map((a) => `${a.name} (Group ${a.group})`);
  return h(
    'div',
    {},
    item.requirement ? h('div', { class: 'small muted' }, `Needs: ${item.requirement}`) : null,
    got.length ? h('div', { class: 'small' }, `Approved by: ${got.join(', ')}`) : null,
    item.rejection ? h('div', { class: 'small' }, `Rejected by ${item.rejection.name}: ${item.rejection.remarks}`) : null,
  );
}

const VIEWS = {
  async dashboard() {
    const [account, payments] = await Promise.all([api('GET', '/api/account'), api('GET', '/api/payments')]);
    const pending = payments.filter((p) => p.status === 'PENDING_AUTHORIZATION');
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'grid cols-3' },
        stat('Ledger balance', inr(account.balance)),
        stat('Available balance', inr(account.available), 'Balance minus funds earmarked for pending payments'),
        stat('Payments awaiting authorization', String(pending.length), inr(pending.reduce((s, p) => s + p.amount, 0))),
      ),
      h('section', { class: 'card' }, h('h2', {}, `Account ${account.accountNo}`), h('h3', { class: 'muted' }, 'Recent transactions'),
        table(
          ['Date', 'Narration', 'Reference', { label: 'Debit', num: true }, { label: 'Credit', num: true }, { label: 'Balance', num: true }],
          account.ledger.map((l) => [
            dt(l.at),
            l.narration,
            l.ref || '',
            l.type === 'DEBIT' ? inr(l.amount) : '',
            l.type === 'CREDIT' ? inr(l.amount) : '',
            inr(l.balanceAfter),
          ]),
        ),
      ),
    );
  },

  async beneficiaries() {
    const list = await api('GET', '/api/beneficiaries');
    const wrap = h('div', {});
    if (me.user.role === 'MAKER') {
      const form = h(
        'form',
        { class: 'card' },
        h('h2', {}, 'Add beneficiary'),
        h('p', { class: 'muted small' }, 'New beneficiaries must be authorized by your checkers on the bank portal before payments can be made.'),
        h(
          'div',
          { class: 'row' },
          h('label', {}, 'Beneficiary name', h('input', { name: 'name', required: true })),
          h('label', {}, 'Account number', h('input', { name: 'accountNo', required: true, inputmode: 'numeric', pattern: '\\d{9,18}' })),
          h('label', {}, 'IFSC', h('input', { name: 'ifsc', required: true, pattern: '[A-Za-z]{4}0[A-Za-z0-9]{6}', placeholder: 'HDFC0001234' })),
          h('label', {}, 'Nickname (optional)', h('input', { name: 'nickname' })),
        ),
        h('button', { type: 'submit' }, 'Submit for authorization'),
      );
      onSubmit(form, async (data) => {
        await api('POST', '/api/beneficiaries', data);
        toast('Beneficiary submitted for authorization');
        render();
      });
      wrap.append(form);
    }
    wrap.append(
      h('section', { class: 'card' }, h('h2', {}, 'Beneficiaries'),
        table(
          ['Name', 'Account / IFSC', 'Status', 'Created by', 'Authorization'],
          list.map((b) => [
            h('div', {}, b.name, b.nickname ? h('div', { class: 'small muted' }, b.nickname) : null),
            `${b.accountNo} · ${b.ifsc}`,
            badge(b.status),
            h('div', {}, b.createdByName, h('div', { class: 'small muted' }, dt(b.createdAt))),
            approvalsCell(b),
          ]),
        ),
      ),
    );
    return wrap;
  },

  async payments() {
    const [list, bens] = await Promise.all([api('GET', '/api/payments'), api('GET', '/api/beneficiaries')]);
    const wrap = h('div', {});
    if (me.user.role === 'MAKER') {
      const active = bens.filter((b) => b.status === 'ACTIVE');
      const form = h(
        'form',
        { class: 'card' },
        h('h2', {}, 'New payment'),
        h('p', { class: 'muted small' }, 'Funds are earmarked when you submit, and debited only after authorization as per your Mode of Operation.'),
        h(
          'div',
          { class: 'row' },
          h('label', {}, 'Beneficiary', h('select', { name: 'beneficiaryId', required: true },
            h('option', { value: '' }, active.length ? 'Select…' : 'No authorized beneficiaries'),
            active.map((b) => h('option', { value: b.id }, `${b.name} – ${b.accountNo}`)))),
          h('label', {}, 'Amount (₹)', h('input', { name: 'amount', type: 'number', min: '1', step: '0.01', required: true })),
          h('label', {}, 'Mode', h('select', { name: 'mode' },
            h('option', { value: 'NEFT' }, 'NEFT'), h('option', { value: 'IMPS' }, 'IMPS (up to ₹5L)'), h('option', { value: 'RTGS' }, 'RTGS (₹2L and above)'))),
          h('label', {}, 'Remarks', h('input', { name: 'remarks', maxlength: '60' })),
        ),
        h('button', { type: 'submit' }, 'Submit for authorization'),
      );
      onSubmit(form, async (data) => {
        const p = await api('POST', '/api/payments', { ...data, amount: Number(data.amount) });
        toast(`Payment submitted. Needs: ${p.requirement}`);
        render();
      });
      wrap.append(form);
    }
    wrap.append(
      h('section', { class: 'card' }, h('h2', {}, 'Payments'),
        table(
          ['Date', 'Beneficiary', { label: 'Amount', num: true }, 'Mode', 'Status', 'Authorization'],
          list.map((p) => [
            h('div', {}, dt(p.createdAt), h('div', { class: 'small muted' }, `by ${p.createdByName}`)),
            h('div', {}, p.beneficiaryName, h('div', { class: 'small muted' }, p.remarks || '')),
            inr(p.amount),
            p.mode,
            h('div', {}, badge(p.status), p.utr ? h('div', { class: 'small muted' }, p.utr) : null, p.failureReason ? h('div', { class: 'small' }, p.failureReason) : null),
            approvalsCell(p),
          ]),
        ),
      ),
    );
    return wrap;
  },

  async authorizations() {
    const items = await api('GET', '/api/authorizations');
    return h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Pending authorization'),
      h('p', { class: 'muted small' }, 'Authorization happens on the bank\'s secure portal. Clicking "Authorize" opens a bank pop-up for that transaction only; you will confirm with an OTP.'),
      table(
        ['Type', 'Details', { label: 'Amount', num: true }, 'Maker', 'Authorization', ''],
        items.map((i) => [
          h('span', { class: 'badge' }, i.kind === 'payment' ? 'Payment' : 'Beneficiary'),
          i.kind === 'payment'
            ? h('div', {}, `${i.beneficiaryName} · ${i.mode}`, h('div', { class: 'small muted' }, i.remarks || ''))
            : h('div', {}, i.name, h('div', { class: 'small muted' }, `${i.accountNo} · ${i.ifsc}`)),
          i.kind === 'payment' ? inr(i.amount) : '—',
          h('div', {}, i.createdByName, h('div', { class: 'small muted' }, dt(i.createdAt))),
          approvalsCell(i),
          i.canAuthorize
            ? h('button', { type: 'button', onclick: (e) => authorize(i, e.currentTarget) }, 'Authorize')
            : h('span', { class: 'small muted' }, i.createdBy === me.user.id ? 'Your own item' : 'No action needed from you'),
        ]),
        'No transactions are waiting for authorization.',
      ),
    );
  },

  async mop() {
    return h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Mode of Operation'),
      h('p', { class: 'muted small' }, 'Agreed with the bank at onboarding. The bank enforces it on every authorization.'),
      h('ul', { class: 'plain' }, me.mop.map((line) => h('li', {}, line))),
    );
  },
};

function stat(label, value, sub) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
}

// Opens the Bank's authorization pop-up for one transaction.
async function authorize(item, button) {
  // Open synchronously inside the click handler so pop-up blockers allow it.
  const win = window.open('about:blank', 'bank-authorization', 'popup,width=560,height=780');
  button.disabled = true;
  try {
    const { url } = await api('POST', `/api/authorizations/${item.kind}/${item.id}/session`);
    if (!win || win.closed) {
      toast('Pop-up was blocked. Please allow pop-ups for this site and try again.', true);
      return;
    }
    win.location.href = url;
    const timer = setInterval(() => {
      if (win.closed) {
        clearInterval(timer);
        render();
      }
    }, 800);
  } catch (err) {
    win?.close();
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

init();
