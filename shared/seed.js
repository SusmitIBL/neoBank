// Demo data shared by both mock systems so they start in a consistent state.
import { hashPassword } from './security.js';

export const DEMO_PASSWORD = 'Pass@123';

export const DEMO_MOP = {
  rules: [
    { appliesTo: 'BENEFICIARY', minAmount: 0, maxAmount: null, anyOf: [{ A: 1 }, { B: 1 }] },
    { appliesTo: 'PAYMENT', minAmount: 0, maxAmount: 100000, anyOf: [{ A: 1 }, { B: 1 }] },
    { appliesTo: 'PAYMENT', minAmount: 100000, maxAmount: 1000000, anyOf: [{ A: 1, B: 1 }, { A: 2 }] },
    { appliesTo: 'PAYMENT', minAmount: 1000000, maxAmount: null, anyOf: [{ A: 2, B: 1 }] },
  ],
};

export const DEMO_CLIENT = {
  id: 'cli_acme',
  name: 'Acme Industries Pvt Ltd',
  cin: 'U12345MH2020PTC123456',
  accountNo: '50200012345678',
};

export const DEMO_USERS = [
  { id: 'usr_acme_maker', username: 'acme.maker', name: 'Riya Maker', role: 'MAKER', group: null },
  { id: 'usr_acme_chk_a1', username: 'acme.checker1', name: 'Arjun Checker (A)', role: 'CHECKER', group: 'A' },
  { id: 'usr_acme_chk_a2', username: 'acme.checker2', name: 'Anita Checker (A)', role: 'CHECKER', group: 'A' },
  { id: 'usr_acme_chk_b1', username: 'acme.checker3', name: 'Bala Checker (B)', role: 'CHECKER', group: 'B' },
];

export function seedNeobank() {
  const now = new Date().toISOString();
  return {
    admins: [{ id: 'nba_1', username: 'nbadmin', name: 'Neobank Admin', passwordHash: hashPassword('Admin@123') }],
    clients: [{ ...DEMO_CLIENT, status: 'ACTIVE', mop: DEMO_MOP, createdAt: now, createdBy: 'seed' }],
    users: DEMO_USERS.map((u) => ({
      ...u,
      clientId: DEMO_CLIENT.id,
      status: 'ACTIVE',
      passwordHash: hashPassword(DEMO_PASSWORD),
    })),
    beneficiaries: [
      {
        id: 'ben_seed1',
        clientId: DEMO_CLIENT.id,
        name: 'Globex Supplies LLP',
        accountNo: '001122334455',
        ifsc: 'HDFC0000123',
        nickname: 'Globex',
        status: 'ACTIVE',
        createdBy: 'usr_acme_maker',
        createdAt: now,
        approvals: [],
      },
    ],
    payments: [],
    audit: [],
  };
}

export function seedBank() {
  const now = new Date().toISOString();
  return {
    admins: [{ id: 'bka_1', username: 'bankadmin', name: 'Bank Admin', passwordHash: hashPassword('Bank@123') }],
    clients: [
      {
        ...DEMO_CLIENT,
        status: 'ACTIVE',
        mop: DEMO_MOP,
        authorizers: DEMO_USERS.filter((u) => u.role === 'CHECKER').map((u) => ({
          userId: u.id,
          name: u.name,
          group: u.group,
        })),
        submittedAt: now,
        decidedAt: now,
        decidedBy: 'seed',
      },
    ],
    accounts: [{ accountNo: DEMO_CLIENT.accountNo, clientId: DEMO_CLIENT.id, balance: 2500000, held: 0 }],
    ledger: [
      {
        id: 'txn_seed',
        accountNo: DEMO_CLIENT.accountNo,
        type: 'CREDIT',
        amount: 2500000,
        balanceAfter: 2500000,
        narration: 'Opening balance',
        at: now,
      },
    ],
    cases: [],
    sessions: [],
    outbox: [],
    audit: [],
  };
}
