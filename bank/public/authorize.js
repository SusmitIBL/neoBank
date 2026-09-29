// Bank authorization pop-up: shows exactly one transaction and records the
// signatory's decision after OTP verification.
import { api, h, $, inr, dt, badge } from '/shared/ui.js';

const rid = new URLSearchParams(location.search).get('rid');
const app = $('#app');
let session;
let timerId;

function fail(message) {
  app.replaceChildren(
    h('div', { class: 'notice bad' }, message),
    h('button', { type: 'button', class: 'secondary', onclick: () => window.close() }, 'Close window'),
  );
}

function notifyOpener(result) {
  // Target the Neobank origin explicitly so no other window can receive the result.
  if (window.opener && session) {
    window.opener.postMessage({ type: 'bank-authorization-complete', ...result }, session.neobankOrigin);
  }
}

function startTimer(expiresAt) {
  const el = $('#timer');
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    el.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (!left) {
      clearInterval(timerId);
      fail('This authorization session has expired. Close this window and start again.');
    }
  };
  timerId = setInterval(tick, 1000);
  tick();
}

function details(t) {
  const d = t.details;
  if (t.type === 'PAYMENT') {
    return h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Pay to'), h('dd', {}, d.beneficiaryName),
      h('dt', {}, 'Account / IFSC'), h('dd', {}, `${d.accountNo} · ${d.ifsc}`),
      h('dt', {}, 'Mode'), h('dd', {}, d.mode),
      h('dt', {}, 'Remarks'), h('dd', {}, d.remarks || '—'),
    );
  }
  return h(
    'dl',
    { class: 'kv' },
    h('dt', {}, 'Beneficiary'), h('dd', {}, d.name),
    h('dt', {}, 'Account'), h('dd', {}, d.accountNo),
    h('dt', {}, 'IFSC'), h('dd', {}, d.ifsc),
    h('dt', {}, 'Nickname'), h('dd', {}, d.nickname || '—'),
  );
}

async function init() {
  if (!rid) return fail('Missing authorization reference.');
  try {
    session = await api('GET', `/popup/sessions/${encodeURIComponent(rid)}`);
  } catch (err) {
    return fail(err.message);
  }
  const t = session.transaction;
  startTimer(session.expiresAt);

  const otp = h('input', { name: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '\\d{6}', required: true });
  const remarks = h('input', { name: 'remarks', maxlength: '120', placeholder: 'Required if rejecting' });
  const error = h('div', { class: 'notice bad hidden' });
  const approveBtn = h('button', { type: 'button' }, t.type === 'PAYMENT' ? `Authorize ${inr(t.amount)}` : 'Authorize beneficiary');
  const rejectBtn = h('button', { type: 'button', class: 'danger' }, 'Reject');

  async function decide(decision) {
    error.classList.add('hidden');
    approveBtn.disabled = rejectBtn.disabled = true;
    try {
      const result = await api('POST', `/popup/sessions/${encodeURIComponent(rid)}/decision`, {
        otp: otp.value.trim(),
        decision,
        remarks: remarks.value,
      });
      done(result);
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      approveBtn.disabled = rejectBtn.disabled = false;
      if (err.status === 410 || /locked/.test(err.message)) approveBtn.disabled = rejectBtn.disabled = true;
    }
  }
  approveBtn.onclick = () => decide('APPROVE');
  rejectBtn.onclick = () => decide('REJECT');

  app.replaceChildren(
    h('div', { class: 'notice' }, 'You are on the Partner Bank\'s secure page. Check the details below carefully before authorizing.'),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'role-tag' }, t.type === 'PAYMENT' ? 'Payment authorization' : 'Beneficiary authorization'), h('div', {}, badge(t.status))),
      t.type === 'PAYMENT' ? h('div', { class: 'amount-big' }, inr(t.amount)) : null,
      h('p', { class: 'small muted' }, `From ${session.client.name} · A/c ${session.client.accountNo} · Ref ${t.id}`),
      details(t),
      h('p', { class: 'small muted' }, `Initiated by ${t.makerName} on ${dt(t.createdAt)}`),
    ),
    h(
      'section',
      { class: 'card' },
      h('h3', {}, 'Mode of Operation'),
      h('p', { class: 'small' }, `Required: ${t.requirement}`),
      h('p', { class: 'small' }, t.approvals.length ? `Already authorized by: ${t.approvals.map((a) => `${a.name} (Group ${a.group})`).join(', ')}` : 'No authorizations yet.'),
      h('p', { class: 'small muted' }, `Signing as ${session.authorizer.name}, Group ${session.authorizer.group}`),
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'sms' }, h('strong', {}, 'Mock SMS to your registered mobile: '), session.mockSms),
      h('label', {}, 'Enter OTP', otp),
      h('label', {}, 'Remarks', remarks),
      error,
      h('div', { class: 'actions' }, approveBtn, rejectBtn),
    ),
  );
  otp.focus();
}

function done(result) {
  clearInterval(timerId);
  notifyOpener(result);
  const text = {
    PENDING: 'Your authorization has been recorded. Further approvals are needed as per the Mode of Operation.',
    AUTHORIZED: result.execution?.status === 'FAILED'
      ? `Authorized, but execution failed: ${result.execution.reason}`
      : `Fully authorized.${result.execution?.utr ? ` Payment processed. UTR ${result.execution.utr}` : ''}`,
    REJECTED: 'The transaction has been rejected.',
  }[result.status];
  app.replaceChildren(
    h('div', { class: `notice ${result.status === 'REJECTED' || result.execution?.status === 'FAILED' ? 'bad' : 'ok'}` }, text),
    h('p', { class: 'muted small' }, 'This window will close automatically.'),
    h('button', { type: 'button', class: 'secondary', onclick: () => window.close() }, 'Close now'),
  );
  $('#timer').textContent = '';
  setTimeout(() => window.close(), 3500);
}

init();
