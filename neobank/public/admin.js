import { api, h, $, inr, dt, badge, toast, table, tabs } from '/shared/ui.js';

let current = 'clients';

async function init() {
  let admin;
  try {
    admin = await api('GET', '/api/admin/me');
  } catch {
    location.href = '/';
    return;
  }
  $('#who').textContent = admin.name;
  $('#logout').onclick = async () => {
    await api('POST', '/api/admin/logout');
    location.href = '/';
  };
  tabs($('#tabs'), { clients: 'Corporate clients', onboard: 'Onboard client', transactions: 'Transactions', audit: 'Audit trail' }, (k) => {
    current = k;
    render();
  }).select('clients');
}

async function render() {
  try {
    $('#view').replaceChildren(await VIEWS[current]());
  } catch (err) {
    if (err.status === 401) location.href = '/';
    $('#view').replaceChildren(h('div', { class: 'notice bad' }, err.message));
  }
}

const VIEWS = {
  async clients() {
    const clients = await api('GET', '/api/admin/clients');
    return h(
      'div',
      {},
      clients.map((c) =>
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'row' }, h('h2', {}, c.name), h('div', {}, badge(c.status))),
          h('p', { class: 'small muted' }, `CIN ${c.cin} · Account ${c.accountNo || 'not yet opened'} · onboarded ${dt(c.createdAt)}`),
          c.remarks ? h('div', { class: 'notice bad' }, `Bank remarks: ${c.remarks}`) : null,
          h(
            'div',
            { class: 'grid cols-2' },
            h('div', {}, h('h3', {}, 'Users'), table(['Username', 'Name', 'Role', 'Status'], c.users.map((u) => [u.username, u.name, u.role === 'CHECKER' ? `Checker – Group ${u.group}` : 'Maker', badge(u.status)]))),
            h('div', {}, h('h3', {}, 'Mode of Operation'), h('ul', { class: 'plain small' }, c.mop.map((m) => h('li', {}, m)))),
          ),
        ),
      ),
    );
  },

  async onboard() {
    const usersBox = h('div', {});
    const rulesBox = h('div', {});

    const userRow = (u = {}) => {
      const role = h('select', { name: 'role' }, h('option', { value: 'MAKER' }, 'Maker'), h('option', { value: 'CHECKER' }, 'Checker'));
      role.value = u.role || 'MAKER';
      const group = h('input', { name: 'group', maxlength: '1', placeholder: 'A', value: u.group || '' });
      const syncGroup = () => { group.disabled = role.value !== 'CHECKER'; };
      role.addEventListener('change', syncGroup);
      syncGroup();
      const row = h(
        'div',
        { class: 'row user-row' },
        h('label', {}, 'Username', h('input', { name: 'username', value: u.username || '', required: true })),
        h('label', {}, 'Full name', h('input', { name: 'name', value: u.name || '', required: true })),
        h('label', {}, 'Role', role),
        h('label', {}, 'Authorizer group', group),
        h('label', {}, 'Initial password', h('input', { name: 'password', type: 'password', minlength: '8', required: true })),
        h('button', { type: 'button', class: 'secondary', onclick: () => row.remove() }, 'Remove'),
      );
      usersBox.append(row);
    };

    const ruleRow = (r = {}) => {
      const type = h('select', { name: 'appliesTo' }, h('option', { value: 'PAYMENT' }, 'Payment'), h('option', { value: 'BENEFICIARY' }, 'Beneficiary'));
      type.value = r.appliesTo || 'PAYMENT';
      const min = h('input', { name: 'minAmount', type: 'number', min: '0', value: r.minAmount ?? '' });
      const max = h('input', { name: 'maxAmount', type: 'number', min: '0', placeholder: 'No limit', value: r.maxAmount ?? '' });
      const sync = () => { min.disabled = max.disabled = type.value !== 'PAYMENT'; };
      type.addEventListener('change', sync);
      sync();
      const row = h(
        'div',
        { class: 'row rule-row' },
        h('label', {}, 'Applies to', type),
        h('label', {}, 'Above ₹', min),
        h('label', {}, 'Up to ₹', max),
        h('label', {}, 'Required approvers', h('input', { name: 'combos', value: r.combos || '', placeholder: '1A + 1B | 2A', required: true })),
        h('button', { type: 'button', class: 'secondary', onclick: () => row.remove() }, 'Remove'),
      );
      rulesBox.append(row);
    };

    [
      { role: 'MAKER' },
      { role: 'CHECKER', group: 'A' },
      { role: 'CHECKER', group: 'B' },
    ].forEach(userRow);
    [
      { appliesTo: 'BENEFICIARY', combos: '1A | 1B' },
      { appliesTo: 'PAYMENT', minAmount: 0, maxAmount: 500000, combos: '1A | 1B' },
      { appliesTo: 'PAYMENT', minAmount: 500000, combos: '1A + 1B' },
    ].forEach(ruleRow);

    const form = h(
      'form',
      {},
      h('section', { class: 'card' },
        h('h2', {}, 'Company'),
        h('div', { class: 'row' },
          h('label', {}, 'Registered name', h('input', { id: 'company-name', required: true })),
          h('label', {}, 'CIN', h('input', { id: 'company-cin', required: true, placeholder: 'U12345MH2020PTC123456' })))),
      h('section', { class: 'card' },
        h('h2', {}, 'Users'),
        h('p', { class: 'small muted' }, 'Makers initiate payments and beneficiaries. Checkers are authorized signatories; put them in groups (A, B, …) used by the MOP.'),
        usersBox,
        h('button', { type: 'button', class: 'secondary', onclick: () => userRow() }, '+ Add user')),
      h('section', { class: 'card' },
        h('h2', {}, 'Mode of Operation (MOP)'),
        h('p', { class: 'small muted' },
          'Each rule lists who must approve. Use "1A + 1B" for "one from Group A and one from Group B", and "|" for alternatives, e.g. "1A + 1B | 2A". Payment ranges are "above X, up to Y".'),
        rulesBox,
        h('button', { type: 'button', class: 'secondary', onclick: () => ruleRow() }, '+ Add rule')),
      h('div', { class: 'notice' }, 'On submit, the client and MOP go to the bank for approval. Users can sign in once the bank approves and opens the account.'),
      h('button', { type: 'submit' }, 'Submit to bank'),
    );

    const rowValues = (row) =>
      Object.fromEntries([...row.querySelectorAll('input, select')].map((el) => [el.name, el.disabled ? '' : el.value.trim()]));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const users = [...usersBox.querySelectorAll('.user-row')].map(rowValues).map((u) => ({ ...u, group: u.group.toUpperCase() || null }));
        const mopRules = [...rulesBox.querySelectorAll('.rule-row')].map(rowValues);
        await api('POST', '/api/admin/clients', {
          name: $('#company-name', form).value,
          cin: $('#company-cin', form).value,
          users,
          mopRules,
        });
        toast('Client submitted to the bank for approval');
        current = 'clients';
        document.querySelector('.tabs button').click();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    return form;
  },

  async transactions() {
    const { payments, beneficiaries } = await api('GET', '/api/admin/transactions');
    return h(
      'div',
      {},
      h('section', { class: 'card' }, h('h2', {}, 'Payments'),
        table(['Date', 'Client', 'Beneficiary', { label: 'Amount', num: true }, 'Mode', 'Maker', 'Status'],
          payments.map((p) => [dt(p.createdAt), p.clientName, p.beneficiaryName, inr(p.amount), p.mode, p.createdByName, badge(p.status)]))),
      h('section', { class: 'card' }, h('h2', {}, 'Beneficiaries'),
        table(['Date', 'Client', 'Name', 'Account', 'Maker', 'Status'],
          beneficiaries.map((b) => [dt(b.createdAt), b.clientName, b.name, `${b.accountNo} · ${b.ifsc}`, b.createdByName, badge(b.status)]))),
    );
  },

  async audit() {
    const rows = await api('GET', '/api/admin/audit');
    return h('section', { class: 'card' }, h('h2', {}, 'Audit trail'),
      table(['Time', 'Actor', 'Action', 'Details'], rows.map((a) => [dt(a.at), a.actor, a.action, JSON.stringify(a.details)])));
  },
};

init();
