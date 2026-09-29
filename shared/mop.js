// Mode of Operation (MOP) rules engine.
//
// A MOP is captured when a corporate client is onboarded. It is a list of rules:
//   { appliesTo: 'PAYMENT' | 'BENEFICIARY', minAmount, maxAmount (null = no cap),
//     anyOf: [ { A: 1, B: 1 }, { A: 2 } ] }
// `anyOf` lists alternative combinations of authorizer groups; the transaction is
// authorized once the approvals collected satisfy at least one combination.
// For BENEFICIARY rules the amount range is ignored.

export const TXN_TYPES = ['PAYMENT', 'BENEFICIARY'];
const GROUP_RE = /^[A-Z]$/;

// "1A + 1B | 2A"  ->  [{ A: 1, B: 1 }, { A: 2 }]
export function parseCombos(text) {
  const combos = String(text || '')
    .split('|')
    .map((alt) => alt.trim())
    .filter(Boolean)
    .map((alt) => {
      const combo = {};
      for (const term of alt.split('+').map((t) => t.trim().toUpperCase())) {
        const m = /^(\d+)\s*([A-Z])$/.exec(term);
        if (!m) throw new Error(`Invalid term "${term}" (expected e.g. "1A")`);
        combo[m[2]] = (combo[m[2]] || 0) + Number(m[1]);
      }
      return combo;
    });
  if (!combos.length) throw new Error('At least one authorizer combination is required');
  return combos;
}

export function formatCombos(anyOf) {
  return anyOf
    .map((c) =>
      Object.entries(c)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([g, n]) => `${n} from Group ${g}`)
        .join(' + '),
    )
    .join('  OR  ');
}

// Validates a MOP against the authorizer groups the client actually has.
// `groupSizes` = { A: 2, B: 1 } (number of checkers per group).
export function validateMop(mop, groupSizes) {
  if (!mop || !Array.isArray(mop.rules) || !mop.rules.length) throw new Error('MOP must have at least one rule');
  for (const [i, r] of mop.rules.entries()) {
    const where = `MOP rule ${i + 1}`;
    if (!TXN_TYPES.includes(r.appliesTo)) throw new Error(`${where}: appliesTo must be PAYMENT or BENEFICIARY`);
    if (r.appliesTo === 'PAYMENT') {
      if (!(Number.isFinite(r.minAmount) && r.minAmount >= 0)) throw new Error(`${where}: invalid minAmount`);
      if (r.maxAmount !== null && !(Number.isFinite(r.maxAmount) && r.maxAmount > r.minAmount)) {
        throw new Error(`${where}: maxAmount must be greater than minAmount (or empty for no cap)`);
      }
    }
    if (!Array.isArray(r.anyOf) || !r.anyOf.length) throw new Error(`${where}: needs at least one combination`);
    for (const combo of r.anyOf) {
      const entries = Object.entries(combo || {});
      if (!entries.length) throw new Error(`${where}: empty combination`);
      for (const [g, n] of entries) {
        if (!GROUP_RE.test(g)) throw new Error(`${where}: invalid group "${g}"`);
        if (!(Number.isInteger(n) && n >= 1)) throw new Error(`${where}: count for group ${g} must be >= 1`);
        if ((groupSizes[g] || 0) < n) {
          throw new Error(`${where}: needs ${n} checker(s) in Group ${g} but the client has ${groupSizes[g] || 0}`);
        }
      }
    }
  }
  const ranges = mop.rules.filter((r) => r.appliesTo === 'PAYMENT').sort((a, b) => a.minAmount - b.minAmount);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    if (prev.maxAmount === null || prev.maxAmount > ranges[i].minAmount) {
      throw new Error('MOP payment amount ranges overlap');
    }
  }
  if (mop.rules.filter((r) => r.appliesTo === 'BENEFICIARY').length > 1) {
    throw new Error('Only one BENEFICIARY rule is allowed');
  }
}

// Finds the rule for a transaction. Payment ranges are (minAmount, maxAmount], so
// adjacent rules can share a boundary: 0–1,00,000 then 1,00,000–10,00,000.
export function findRule(mop, type, amount = 0) {
  return (mop?.rules || []).find(
    (r) =>
      r.appliesTo === type &&
      (type !== 'PAYMENT' || (amount > r.minAmount && (r.maxAmount === null || amount <= r.maxAmount))),
  );
}

function countByGroup(approvals) {
  const counts = {};
  for (const a of approvals) counts[a.group] = (counts[a.group] || 0) + 1;
  return counts;
}

export function isSatisfied(anyOf, approvals) {
  const counts = countByGroup(approvals);
  return anyOf.some((combo) => Object.entries(combo).every(([g, n]) => (counts[g] || 0) >= n));
}

// Would one more approval from `group` move the transaction closer to authorization?
export function isGroupNeeded(anyOf, approvals, group) {
  const counts = countByGroup(approvals);
  return anyOf.some((combo) => (combo[group] || 0) > (counts[group] || 0));
}

export function describeMop(mop) {
  return (mop?.rules || []).map((r) => {
    let scope = 'Beneficiary add';
    if (r.appliesTo === 'PAYMENT') {
      const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
      scope =
        r.maxAmount === null
          ? `Payments above ${inr(r.minAmount)}`
          : `Payments above ${inr(r.minAmount)} up to ${inr(r.maxAmount)}`;
    }
    return `${scope}: ${formatCombos(r.anyOf)}`;
  });
}
