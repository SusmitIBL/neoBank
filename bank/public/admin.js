import { api, h, $, inr, dt, badge, toast, table, tabs } from '/shared/ui.js';

let current = 'onboarding';

async function init() {
  try {
    const admin = await api('GET', '/api/me');
    $('#who').textContent = admin.name;
  } catch {
    location.href = '/';
    return;
  }
  $('#logout').onclick = async () => {
    await api('POST', '/api/logout');
    location.href = '/';
  };
  tabs($('#tabs'), { onboarding: 'Onboarding requests', clients: 'Clients & accounts', cases: 'Authorizations', audit: 'Audit trail' }, (k) => {
    current = k;
    render();
  }).select('onboarding');
}

async function render() {
  try {
    $('#view').replaceChildren(await VIEWS[current]());
  } catch (err) {
    if (err.status === 401) location.href = '/';
    $('#view').replaceChildren(h('div', { class: 'notice bad' }, err.message));
  }
}

async function act(fn, message) {
  try {
    await fn();
    toast(message);
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

function clientSummary(c) {
  return h(
    'div',
    { class: 'grid cols-2' },
    h('div', {}, h('h3', {}, 'Authorized signatories'), table(['Name', 'Group'], c.authorizers.map((a) => [a.name, `Group ${a.group}`]))),
    h('div', {}, h('h3', {}, 'Mode of Operation'), h('ul', { class: 'plain small' }, c.mop.map((m) => h('li', {}, m)))),
  );
}

const VIEWS = {
  async onboarding() {
    const clients = (await api('GET', '/api/clients')).filter((c) => c.status === 'PENDING_APPROVAL');
    if (!clients.length) return h('div', { class: 'card muted' }, 'No onboarding requests are waiting.');
    return h(
      'div',
      {},
      clients.map((c) => {
        const opening = h('input', { type: 'number', min: '0', value: '1000000' });
        const remarks = h('input', { placeholder: 'Reason (required to reject)' });
        return h(
          'section',
          { class: 'card' },
          h('div', { class: 'row' }, h('h2', {}, c.name), h('div', {}, badge(c.status))),
          h('p', { class: 'small muted' }, `CIN ${c.cin} · submitted ${dt(c.submittedAt)}`),
          clientSummary(c),
          h(
            'div',
            { class: 'row' },
            h('label', {}, 'Opening balance (₹, mock funding)', opening),
            h('div', {}, h('button', { type: 'button', onclick: () => act(() => api('POST', `/api/clients/${c.id}/approve`, { openingBalance: Number(opening.value) }), 'Client approved and account opened') }, 'Approve & open account')),
            h('label', {}, 'Rejection remarks', remarks),
            h('div', {}, h('button', { type: 'button', class: 'danger', onclick: () => act(() => api('POST', `/api/clients/${c.id}/reject`, { remarks: remarks.value }), 'Client rejected') }, 'Reject')),
          ),
        );
      }),
    );
  },

  async clients() {
    const clients = (await api('GET', '/api/clients')).filter((c) => c.status !== 'PENDING_APPROVAL');
    return h(
      'div',
      {},
      clients.map((c) => {
        const amount = h('input', { type: 'number', min: '1', placeholder: 'Amount' });
        return h(
          'section',
          { class: 'card' },
          h('div', { class: 'row' }, h('h2', {}, c.name), h('div', {}, badge(c.status))),
          c.account
            ? h(
                'div',
                { class: 'grid cols-3' },
                h('div', { class: 'stat' }, h('div', { class: 'label' }, `Account ${c.account.accountNo}`), h('div', { class: 'value' }, inr(c.account.balance))),
                h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Earmarked (pending payments)'), h('div', { class: 'value' }, inr(c.account.held))),
                h('div', { class: 'row' },
                  h('label', {}, 'Credit funds (mock)', amount),
                  h('div', {}, h('button', { type: 'button', class: 'secondary', onclick: () => act(() => api('POST', `/api/accounts/${c.account.accountNo}/credit`, { amount: Number(amount.value) }), 'Account credited') }, 'Credit'))),
              )
            : h('p', { class: 'muted' }, c.remarks ? `Rejected: ${c.remarks}` : 'No account'),
          clientSummary(c),
        );
      }),
    );
  },

  async cases() {
    const cases = await api('GET', '/api/cases');
    return h('section', { class: 'card' }, h('h2', {}, 'Authorization cases'),
      h('p', { class: 'small muted' }, 'Every maker-initiated transaction, the MOP requirement applied and the signatories who authorized it.'),
      table(
        ['Created', 'Client', 'Type', 'Details', { label: 'Amount', num: true }, 'Requirement', 'Approvals', 'Status'],
        cases.map((c) => [
          dt(c.createdAt),
          c.clientName,
          c.type,
          c.type === 'PAYMENT' ? `${c.details.beneficiaryName} · ${c.details.mode}` : `${c.details.name} · ${c.details.accountNo}`,
          c.type === 'PAYMENT' ? inr(c.amount) : '—',
          c.requirement,
          c.approvals.map((a) => `${a.name} (${a.group})`).join(', ') || (c.rejection ? `Rejected by ${c.rejection.name}` : '—'),
          h('div', {}, badge(c.status), c.execution ? h('div', { class: 'small muted' }, c.execution.utr || c.execution.reason) : null),
        ]),
      ));
  },

  async audit() {
    const rows = await api('GET', '/api/audit');
    return h('section', { class: 'card' }, h('h2', {}, 'Audit trail'),
      table(['Time', 'Actor', 'Action', 'Details'], rows.map((a) => [dt(a.at), a.actor, a.action, JSON.stringify(a.details)])));
  },
};

init();
