# Loan Management System — short-term item-secured loans, Papua New Guinea

A full web application built from the system description *"Loan Management System — Short-Term Loans, Papua New Guinea"*.
Customers leave a car, laptop or phone (approved brands), borrow from K20 for up to 3 months, and pay any amount at any time
while interest is added every week. Three roles: **Admin**, **Loan Officer**, **CRO (Credit Risk Officer)**.

Stack: Node.js 22, Express 5, SQLite (better-sqlite3), server-rendered EJS. No build step.

## Run it

```bash
npm install
node scripts/seed.js --reset   # optional: about four months of demo activity
npm start                      # http://localhost:3000
```

Demo users (password `Demo#Pass2026`): `admin`, `officer`, `officer2`, `cro` (Port Moresby branch), `officer.lae`, `cro.lae` (Lae branch).
Sign-in sends an SMS code. With no SMS gateway configured, the code is shown on screen (training mode). Set `LMS_SHOW_CODES=0` to turn that off.

```bash
npm test                       # business-rule tests (engine and full lifecycle)
node tests/smoke-ui.js         # opens every screen as each role (server must be running on demo data)
```

## Updating a running server

Pull the new code, install any new packages, then **restart the app** (for example `pm2 restart lms` or `sudo systemctl restart lms`):

```bash
git pull origin main
npm install
pm2 restart lms
```

The server reads its page templates once, at start-up, so it keeps running the version it started with until it is restarted. The version it is running is shown at the bottom of every page and at `/health`. After an update it should match `git rev-parse --short HEAD`.

## Production settings (environment)

| Variable | Purpose |
|---|---|
| `LMS_MASTER_KEY` | 64 hex chars, the AES-256 key for encrypted fields and files. If it is not set, a key is generated in `data/master.key`. **Keep it in a secrets manager and back it up: without it the backups cannot be read.** |
| `LMS_SESSION_SECRET` | Cookie signing secret |
| `LMS_COOKIE_SECURE=1` | Secure cookies over HTTPS. Behind a reverse proxy (nginx, Caddy), the proxy must send `X-Forwarded-Proto: https`; without it the cookie is sent as a normal cookie rather than dropped. |
| `LMS_SHOW_CODES=0` | Hide SMS codes on screen |
| `LMS_SMS_GATEWAY_URL`, `LMS_SMS_GATEWAY_TOKEN` | HTTP SMS gateway (POST `{to, message}`); without it, SMS are logged in the outbox |
| `LMS_DATA_DIR`, `LMS_BACKUP_DIR`, `LMS_BACKUP_DIR2` | Database and uploads, plus the two backup locations |
| `PORT` | HTTP port (default 3000) |
| `LMS_DEV=1` | Development only: re-read page templates on every request |

## How the spec maps to the code

| Spec section | Where |
|---|---|
| Roles and permission table, two-person rules | `src/lib/ctx.js`, checks in every service (`requireRole`); creator ≠ approver, requester ≠ approver for waivers and reversals |
| PNG mobile numbers: contact fields accept only `(+675) 71234567` or `(+675) 7123-4567`; the network is worked out from the prefix — Digicel 70–74 and 79, Telikom 75, 76 and 78, Vodafone 81–83 | `src/lib/phone.js`, `tests/phone.test.js` |
| Customer profile fields, mobile confirmed by SMS code, consents | `src/services/customers.js`, `views/customers/form.ejs` |
| Accepted IDs, the two-valid-IDs rule (1–8), duplicate check | `customers.addId / reviewId / twoIdRule / findDuplicates`; ID numbers stored encrypted with an HMAC for lookup |
| Collateral: approved brands and minimum years, checks before accepting, IMEI (Luhn), stolen list, at least 4 photos | `src/services/items.js` |
| Inspection checklist, grades A–D, share and rate band, assessed value | `loans.valuate / decide`; grade bands in Admin → Settings |
| Bin #: numbered store bins (laptops and phones), key bins (car keys and papers, in the safe) and yard bays (cars); staff type the bin number at intake (for example `c1` or `K-01`; letters, spaces, dashes and leading zeros are matched loosely) and a new number is added to the bin list the first time it is used; full bins are refused; bins are freed when the item leaves; bin # on the tag, the lender's ticket copy, the item store, stock counts and the return screen; scan a bin number to see what is in it; the Admin adds bins | `src/services/bins.js`, Custody → Bins, `tests/bins.test.js` |
| Redemption counter: scan the ticket (or search by customer name or mobile), see the payoff and the bin to pull from, take the payment and go straight to the item return | `/loans/redeem`, `views/loans/redeem.ejs` |
| Custody, every movement, car yard viewings, device password (encrypted, CRO-only, deleted on return or sale) | `items.js`, `views/items/view.ejs` |
| Loan product, own copy of terms, key dates | `loans.release` (`terms_snapshot`), `src/lib/engine.js` |
| Weekly interest, fees → interest → principal, worked example | `src/lib/engine.js` (pure replay); `tests/engine.test.js` reproduces K1,000 → K1,260 and the K140 → K476 ticket sample |
| Pledge ticket (PBA 1951), Disclosure Statement, two copies, barcode, replacement and EXPIRED reprints | `views/print/ticket.ejs`, `loans.replaceTicket` |
| Payments, channels, holding list for transfers, overpayment refunds, reversals as new entries, waivers | `loans.postPayment`, `src/services/payments.js` |
| Maturity → grace → forfeiture → auction → surplus/shortfall (s.19) | `src/services/jobs.js`, `loans.declareForfeit / approveReserve / recordListing / recordSale / payRefund` |
| Expiry conditions, nightly pull-out, 7-day advance list, early pull-out, restore, 7-year retention, deletion log | `src/services/archive.js` |
| Notifications (SMS in English or Tok Pisin, in-app, call tasks) | `src/services/notify.js`, nightly job |
| Reports (9) with Excel and PDF export; role dashboards | `src/services/reports.js`, `src/lib/export.js`, `src/routes/dashboard.js` |
| Security: SMS sign-in code, strong passwords, 15-minute idle logout, lockout after 5 attempts, CSRF, encrypted data and files, masked ID numbers, an audit log that cannot be edited (enforced by a database trigger) | `src/server.js`, `src/services/users.js`, `src/lib/crypto.js`, `src/db.js` |
| Monthly stock count (Loan Officer counts → CRO signs off → Admin reviews), store access log | `src/services/stock.js` |
| AML/CTF: sanctions screening, large-cash and repeated high-value flags, FASU reporting | `src/services/aml.js` |
| Daily encrypted backups in two locations, restore test | `src/services/backup.js`, Admin → Nightly job & backups |

## Interpretations (please confirm)

* **Next of kin** was removed from the customer form at the lender's request (the system description lists it as required). The database columns are kept, so details already saved stay on record.

* **Several items with different grades:** the loan limit is the sum of each item's allowed amount, and the weekly rate must fall in the band of the *lowest-graded* item.
* **Interest after forfeiture:** interest stops on the forfeiture date. The surplus or shortfall is measured against the amount owed at forfeiture.
* **Forfeiture timing:** the CRO can declare forfeiture from the grace end date onward, if the balance is still not zero.
* **"Paid – item awaiting collection"** is an extra status between a zero balance and the item's return.
* **A person authorised in writing** must show one of the customer's registered IDs, and the written authority is scanned in.
* **Car mileage at return:** up to 5 km over the intake reading is allowed (a setting); anything more needs a note.
* **Section 19 surplus period** is a setting (30 days by default). Confirm it with your legal adviser, as the spec says.
* **ID number on the ticket:** the printed ticket shows the full ID number, as a legal record. Every print is logged. Screens show Loan Officers a masked number (****4821).
* **Tok Pisin SMS wording** should be checked by a native speaker. Have the ticket terms and rates reviewed by a lawyer before go-live, as the spec says.
