'use strict';
const db = require('../db');

const DEFAULTS = {
  lender_name: 'Kina Pledge Finance Ltd',
  lender_slogan: 'Fast cash, your goods kept safe',
  min_loan: 2000, // toea = K20.00
  term_months: 3,
  rate_options: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  grace_days: 7,
  expiry_days: 30,
  retention_years: 7,
  surplus_payment_days: 30, // confirm the period in s.19 Pawnbrokers Act 1951 with the legal adviser
  min_item_photos: 4,
  car_mileage_tolerance_km: 5,
  aml_cash_threshold: 1000000, // K10,000 cash in or out triggers an AML flag
  aml_high_value: 500000, // K5,000 assessed value counts as "high value"
  aml_repeat_count: 3, // this many high-value items ...
  aml_repeat_days: 90, // ... within this many days triggers a flag
  monthly_lending_target: 15000000, // K150,000
  monthly_collection_target: 12000000, // K120,000
  // The company's bank and mobile-banking details, where customers pay by deposit or transfer.
  company_bank_name: '',
  company_bank_account_name: '',
  company_bank_account_no: '',
  company_bank_branch: '',
  company_mobile_banking: '',
  // ---- Company description printed on the pledge ticket (Admin → Settings; one item per line).
  // {months} is replaced by the loan term. Have a lawyer review this wording before go-live.
  pledge_terms: [
    'We will label and hold the Goods for {months} months until the Redemption Date. We will not dispose of the Goods on or before the Redemption Date unless you redeem them before that date.',
    'You may inspect the Goods (but cannot handle them) and ask us to demonstrate their operation at any reasonable time.',
    'You must produce this Pledge Ticket and pay the Redemption Price on or before the Redemption Date to redeem the Goods. You cannot pay by cheque or credit card unless agreed with us prior to redeeming the Goods.',
    'If the Goods comprise more than one item, they cannot be redeemed separately.',
    'We are entitled to assume, in the absence of proof to the contrary, that the holder of this Pledge Ticket is the owner of the Goods.',
    "You can obtain a replacement Pledge Ticket if you produce a current passport, current driver's licence which includes a photograph, or other identification documents which positively establish your identity to our satisfaction.",
    'If you do not redeem your Goods, we will offer them for sale at a public internet auction. If the Goods are not sold via internet auction, we may sell them by any other reasonable means.',
    'We are not liable for any loss or damage to the Goods due to burglary, fire, theft or any circumstances beyond our reasonable control. You should insure the Goods separately.',
    'This Pledge Ticket should be read in conjunction with the attached Disclosure Statement and Schedule.',
  ],
  pledge_confirmations: [
    'The details provided above are correct and you are over the age of 18;',
    'Your identity has been correctly established and the identification details listed above under the heading "ID" are correct;',
    'You have received the Amount Advanced;',
    'You are the owner of the Goods and grant us a security interest in the Goods, and there are no prior security interests in, or third party claims to, the Goods. You warrant that you are not registered for GST;',
  ],
  pledge_rights: [
    'At any time to redeem pledged goods on payment of the Redemption Price.',
    'At any reasonable time to inspect pledged goods (this may consist of the pledger viewing but not handling the goods or the pawnbroker demonstrating their operation).',
  ],
  pledge_obligations: [
    'To keep at their place of business a pawnbrokers record that accurately records the information about the pledger, the goods, redemption of the goods and the financial transaction we are entering into. This Pledge Ticket details that information.',
    'To verify the identity and age of every pledger of goods (a pledger must be 18 years or older).',
    "To provide pledgers with a Pledge Ticket (this document) that meets the requirements of the PBA and to issue a replacement Pledge Ticket if we are satisfied of the pledger's identity.",
    'Not to dispose of pledged goods before the Redemption Date other than by redemption by the pledger or in accordance with the PBA.',
    'To affix a label in the prescribed form to pledged goods until they are redeemed.',
    'Except as provided above, not to purchase goods that are subject to a pawnbroking contract with the pawnbroker.',
    "To record any redemption or purchase of the pledged goods in the pawnbroker's record.",
    'To pay any excess over the Redemption Price to the pledger within the estimated timeframes required by section 19 of the PBA.',
  ],
  // Earlier wording (no longer printed; kept so old settings still load).
  ticket_terms: [
    'Holding period: the goods in Schedule 1 are held by the pawnbroker as security from the contract date until the redemption date shown, plus the grace period stated in the Disclosure Statement.',
    'Inspection: the pledger may look at the goods at the redemption address during business hours, only with a staff member present. Cars stay in the secure yard and must not be driven, used, moved or emptied until the loan is fully paid.',
    'Redemption: the goods are returned only when the full amount owing is K0.00, on presentation of this ticket and one of the same identity documents shown when pledging, by the pledger or a person they named in writing. Goods pledged on one ticket are redeemed together.',
    'Ownership: the pledger states that they are the sole owner of the goods, that no other person or lender has any claim over them, and that they are not stolen.',
    'Replacement ticket: if this ticket is lost, a replacement marked "Replacement" will be issued only after the pledger shows a current passport, driver\'s licence or other photo ID. The old ticket is then cancelled.',
    'Auction: if the goods are not redeemed by the end of the grace period they are forfeited and may be sold at a public internet auction, or by other reasonable means if they do not sell there.',
    'Surplus: if the sale price is more than the amount owing, the surplus is paid to the pledger within the time required by section 19 of the Pawnbrokers Act 1951.',
    'Liability: goods are held at the pawnbroker\'s risk while in its custody and the store and yard are insured. The pawnbroker is not responsible for loss of data on devices.',
    'Disclosure statement: the attached Disclosure Statement forms part of this contract and sets out the amount advanced, the weekly charge and the redemption price.',
  ],
  pledger_confirmations:
    'I confirm that: I am 18 years of age or over; the identity details above are correct; I have received the amount advanced shown above; I am the owner of the goods with no other claims over them; and I am not registered for GST.',
  rights_obligations:
    'Your rights: to receive a copy of this ticket and Disclosure Statement; to redeem your goods at any time before forfeiture by paying the amount owing (a lesser amount applies if you redeem early); to inspect your goods; to receive any surplus from a sale. Our obligations: to keep your goods safe and insured; to return them when you pay in full; to sell forfeited goods only as these terms and the Pawnbrokers Act 1951 allow and to account to you for any surplus.',
  disclosure_extra:
    'Interest is charged once a week on the principal still owed, starting on the release date (so at least one week\'s interest is always payable). Unpaid interest is not itself charged interest. You may pay any amount at any time by cash at the branch, bank deposit or mobile banking transfer quoting your loan number. Each payment pays fees first, then interest, then principal. There are no renewals or extensions.',
};

function get(key) {
  const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return DEFAULTS[key];
  return JSON.parse(row.value);
}
function all() {
  const out = { ...DEFAULTS };
  for (const r of db.get().prepare('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
  return out;
}
function set(key, value) {
  db.get().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// Company bank details for customer payments; empty fields are left out.
function companyBank() {
  const s = all();
  const b = {
    bank: s.company_bank_name, accountName: s.company_bank_account_name, accountNo: s.company_bank_account_no,
    branch: s.company_bank_branch, mobile: s.company_mobile_banking,
  };
  b.any = Object.values(b).some(Boolean);
  b.text = [b.bank && `${b.bank}${b.branch ? ' ' + b.branch : ''}`, b.accountName && `account name ${b.accountName}`, b.accountNo && `account no. ${b.accountNo}`, b.mobile && `mobile banking ${b.mobile}`].filter(Boolean).join(', ');
  return b;
}

function grades() { return db.get().prepare('SELECT * FROM grades ORDER BY grade').all(); }
function grade(g) { return db.get().prepare('SELECT * FROM grades WHERE grade = ?').get(g); }

function seedReferenceData() {
  const d = db.get();
  const now = new Date().toISOString();
  if (!d.prepare('SELECT 1 FROM grades LIMIT 1').get()) {
    const ins = d.prepare('INSERT INTO grades(grade, description, share_pct, rate_min, rate_max, accepted) VALUES (?,?,?,?,?,?)');
    ins.run('A', 'Like new, no faults; cars with low mileage for their age', 60, 10, 12, 1);
    ins.run('B', 'Light wear, small dents or scratches, no mechanical faults', 50, 13, 15, 1);
    ins.run('C', 'Clear wear or minor faults that do not stop use; cars with high mileage', 35, 16, 20, 1);
    ins.run('D', 'Major faults, heavy damage, or hard to resell', 0, null, null, 0);
  }
  if (!d.prepare('SELECT 1 FROM id_types LIMIT 1').get()) {
    const ins = d.prepare('INSERT INTO id_types(name, issued_by, photo, use, is_photo_id) VALUES (?,?,?,?,?)');
    ins.run('PNG National ID (NID) card', 'Civil and Identity Registry', 'yes', 'primary', 1);
    ins.run('Passport', 'Immigration and Citizenship Authority', 'yes', 'primary', 1);
    ins.run("Driver's licence", 'Road Traffic Authority / NLTB', 'yes', 'primary', 1);
    ins.run('Employer staff ID card', 'Employer', 'yes', 'secondary', 1);
    ins.run('Superannuation member card', 'NASFUND, Nambawan Super', 'varies', 'secondary', 0);
    ins.run('Student or institution ID', 'University or college', 'yes', 'secondary', 1);
    ins.run('Birth certificate', 'Civil and Identity Registry', 'no', 'secondary_only', 0);
  }
  if (!d.prepare('SELECT 1 FROM brands LIMIT 1').get()) {
    const ins = d.prepare('INSERT INTO brands(category, name, min_model_year) VALUES (?,?,?)');
    for (const b of ['Toyota', 'Nissan', 'Isuzu', 'Mitsubishi', 'Mazda', 'Ford']) ins.run('car', b, 2008);
    for (const b of ['Apple', 'HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Microsoft']) ins.run('laptop', b, 2018);
    for (const b of ['Apple', 'Samsung', 'Google', 'Huawei', 'Oppo']) ins.run('phone', b, 2020);
  }
  if (!d.prepare('SELECT 1 FROM fees LIMIT 1').get()) {
    d.prepare('INSERT INTO fees(category, name, amount, active) VALUES (?,?,?,1)').run('car', 'Car yard storage fee', 5000);
  }
  if (!d.prepare('SELECT 1 FROM branches LIMIT 1').get()) {
    d.prepare('INSERT INTO branches(code, name, phone, email, postal_address, physical_address, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('POM', 'Port Moresby – Waigani', '+675 325 0000', 'waigani@kinapledge.com.pg', 'PO Box 1000, Boroko, NCD',
        'Section 12, Lot 5, Wards Road, Hohola, NCD', now);
  }
  // Numbered bins (store bins, key bins, yard bays) for any branch that has none.
  const bins = require('./bins');
  for (const b of d.prepare('SELECT id FROM branches').all()) bins.seedBranch(b.id);
}

module.exports = { DEFAULTS, get, all, set, companyBank, grades, grade, seedReferenceData };
