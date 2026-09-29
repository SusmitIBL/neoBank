# NeoBank – Corporate Banking Portal (with mock Partner Bank)

A corporate neobank platform with **maker–checker** workflows where every
authorization happens **on the partner bank's portal**, through a pop-up opened
from the neobank, and is enforced against the client's **Mode of Operation (MOP)**.

Zero dependencies: Node.js ≥ 18 only.

```bash
npm start        # NeoBank on http://localhost:3000, mock Bank on http://localhost:4000
npm test         # unit + end-to-end tests
```

Delete `data/` to reset the demo data.

## Portals and logins

| Portal | URL | Who | Demo login |
|---|---|---|---|
| NeoBank – Corporate | `:3000` | Client **Maker** / **Checker** (end users) | `acme.maker`, `acme.checker1` (Group A), `acme.checker2` (Group A), `acme.checker3` (Group B) – `Pass@123` |
| NeoBank – Admin | `:3000` | **Neobank Admin** | `nbadmin` / `Admin@123` |
| Partner Bank | `:4000` | **Bank Admin** | `bankadmin` / `Bank@123` |

The landing page at `:3000` shows all three sign-in options.

## Demo MOP (Acme Industries)

| Transaction | Required authorization |
|---|---|
| Beneficiary add | 1 from Group A **or** 1 from Group B |
| Payment up to ₹1,00,000 | 1 from A **or** 1 from B |
| Payment above ₹1,00,000 up to ₹10,00,000 | (1 A + 1 B) **or** 2 A |
| Payment above ₹10,00,000 | 2 A + 1 B |

## Try it

1. Sign in as `acme.maker` → **Payments** → pay ₹2,50,000 to Globex via RTGS.
   The funds are earmarked (the available balance drops, the ledger balance doesn't).
2. Sign in as `acme.checker1` (use a private window or another browser) →
   **Pending authorization** → **Authorize**. The **bank pop-up** opens and shows only
   that transaction. Enter the OTP shown in the "mock SMS" box → *Authorize*. Status: 1 of 2.
3. Sign in as `acme.checker3` (Group B) and authorize. The MOP is now met, so the bank
   debits the account and returns a UTR. The payment shows **COMPLETED** for everyone.
4. As `nbadmin` → **Onboard client**: add users, groups and MOP rules → *Submit to bank*.
   As `bankadmin` → **Onboarding requests** → *Approve & open account*. The new client's users can now sign in.

## How it works

```
 Corporate Maker           NeoBank backend                    Bank backend
 ───────────────           ───────────────                    ────────────
 create payment ─────────► validate ──── S2S (HMAC) ────────► create case: resolve MOP rule,
                           status PENDING_AUTHORIZATION        earmark funds
 Corporate Checker
 click "Authorize" ──────► checks role / four-eyes ─ S2S ────► single-use session (5 min, bound
                                                              to checker + case) → pop-up URL
 ┌──────── pop-up window on the BANK origin ─────────┐
 │ shows exact txn · OTP · Approve / Reject           │ ────► verify OTP, re-check eligibility,
 └────────────────────────────────────────────────────┘       record approval, evaluate MOP
                                                              if satisfied: debit + UTR
                           ◄──── signed webhook (outbox, retried) ──
 UI refresh ◄── postMessage (origin-checked, UX only) ─ pop-up closes
```

### Security controls (mock-level, but designed the real way)

- **Authorization only on the bank.** The neobank can't mark anything authorized.
  Status changes come only from a **signed bank webhook**. The pop-up's `postMessage`
  only triggers a UI refresh; it targets the neobank origin and the receiver checks the sender's origin.
- **No transaction data in the pop-up URL.** It carries only an opaque single-use `rid`.
  The bank renders the details from its own record (dynamic linking: what you see is what you sign).
- **Four-eyes / MOP enforced at the bank:** a maker can't authorize, each checker can sign
  once, only groups still needed by the MOP may sign, and eligibility is re-checked at decision time.
- **OTP**: 3 attempts, then the session locks. Sessions expire after 5 minutes and are single-use.
- **S2S calls** use HMAC-SHA256 over timestamp + method + path + body, with a ±5-minute window
  and replay protection. Webhooks are idempotent (event ids), and case creation is idempotent (refId).
- **Funds earmarking**: amount held on submission, released on rejection, debited on authorization.
- scrypt password hashes, HttpOnly + SameSite=Strict cookies, a strict CSP, `X-Frame-Options: DENY`
  (the pop-up can't be framed or clickjacked), DOM built without `innerHTML`, and an audit trail on both sides.

### Project layout

```
start.js              starts both systems
shared/               http framework, security (sessions, HMAC), MOP engine, store, seed data
shared/public/        shared CSS + UI helpers
neobank/server.js     NeoBank API: admin onboarding, maker/checker, webhooks
neobank/public/       landing (3 logins), admin console, corporate portal
bank/server.js        Mock bank: admin, S2S API, authorization pop-up, ledger, webhooks
bank/public/          bank admin UI, authorization pop-up
test/                 MOP unit tests + end-to-end flow tests
```

## Mock shortcuts and what production would need

| Mock | Production |
|---|---|
| OTP shown in the pop-up ("mock SMS") | SMS/soft-token/FIDO2 to the signatory's registered device; OTP stored hashed |
| JSON files | PostgreSQL with transactions, row locks, amounts in paise (integers) |
| In-memory login sessions, passwords only | Central IdP (e.g. Keycloak) with MFA for all portals, password policy, lockout |
| Shared HMAC secret | mTLS + per-partner keys (or signed JWT/JWS), secret manager, key rotation |
| Instant "execution" + fake UTR | Real NEFT/RTGS/IMPS rails, async settlement, reconciliation |
| Bank admin is a single role | Bank-side maker–checker for onboarding approvals and account credits |
| — | Rate limiting, CSRF tokens, HTTPS/HSTS, case expiry jobs, bulk payments/collections, notifications |

Region assumption: India (INR, IFSC, NEFT/RTGS/IMPS, CIN, "Mode of Operation").
