import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCombos, findRule, isSatisfied, isGroupNeeded, validateMop } from '../shared/mop.js';
import { DEMO_MOP } from '../shared/seed.js';

test('parseCombos parses alternatives and groups', () => {
  assert.deepEqual(parseCombos('1A + 1B | 2a'), [{ A: 1, B: 1 }, { A: 2 }]);
  assert.throws(() => parseCombos('A1'), /Invalid term/);
  assert.throws(() => parseCombos(''), /At least one/);
});

test('findRule uses (min, max] payment ranges', () => {
  assert.deepEqual(findRule(DEMO_MOP, 'PAYMENT', 100000).anyOf, [{ A: 1 }, { B: 1 }]);
  assert.deepEqual(findRule(DEMO_MOP, 'PAYMENT', 100000.01).anyOf, [{ A: 1, B: 1 }, { A: 2 }]);
  assert.deepEqual(findRule(DEMO_MOP, 'PAYMENT', 5e7).anyOf, [{ A: 2, B: 1 }]);
  assert.ok(findRule(DEMO_MOP, 'BENEFICIARY'));
});

test('isSatisfied / isGroupNeeded', () => {
  const anyOf = [{ A: 1, B: 1 }, { A: 2 }];
  assert.equal(isSatisfied(anyOf, [{ group: 'A' }]), false);
  assert.equal(isSatisfied(anyOf, [{ group: 'A' }, { group: 'B' }]), true);
  assert.equal(isSatisfied(anyOf, [{ group: 'A' }, { group: 'A' }]), true);
  assert.equal(isGroupNeeded([{ A: 2, B: 1 }], [{ group: 'B' }], 'B'), false);
  assert.equal(isGroupNeeded([{ A: 2, B: 1 }], [{ group: 'B' }], 'A'), true);
  assert.equal(isGroupNeeded([{ A: 1 }], [], 'C'), false);
});

test('validateMop rejects impossible or overlapping rules', () => {
  assert.doesNotThrow(() => validateMop(DEMO_MOP, { A: 2, B: 1 }));
  assert.throws(() => validateMop(DEMO_MOP, { A: 1, B: 1 }), /needs 2 checker/);
  const overlapping = {
    rules: [
      { appliesTo: 'PAYMENT', minAmount: 0, maxAmount: 1000, anyOf: [{ A: 1 }] },
      { appliesTo: 'PAYMENT', minAmount: 500, maxAmount: null, anyOf: [{ A: 1 }] },
    ],
  };
  assert.throws(() => validateMop(overlapping, { A: 1 }), /overlap/);
});
