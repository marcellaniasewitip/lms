'use strict';
const Database = require('better-sqlite3');
const { DB_FILE } = require('./config');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  phone TEXT, email TEXT, postal_address TEXT, physical_address TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','loan_officer','cro')),
  branch_id INTEGER REFERENCES branches(id), mobile TEXT NOT NULL,
  password_hash TEXT NOT NULL, must_change_pw INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, last_login_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grades (
  grade TEXT PRIMARY KEY, description TEXT NOT NULL, share_pct INTEGER NOT NULL,
  rate_min INTEGER, rate_max INTEGER, accepted INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fees (
  id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
  amount INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS id_types (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, issued_by TEXT NOT NULL,
  photo TEXT NOT NULL CHECK (photo IN ('yes','no','varies')),
  use TEXT NOT NULL CHECK (use IN ('primary','secondary','secondary_only')),
  is_photo_id INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY, category TEXT NOT NULL CHECK (category IN ('car','laptop','phone')),
  name TEXT NOT NULL, min_model_year INTEGER, min_model TEXT, active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(category, name)
);
CREATE TABLE IF NOT EXISTS stolen_list (
  id INTEGER PRIMARY KEY, number_type TEXT NOT NULL, number_norm TEXT NOT NULL, description TEXT,
  source TEXT, added_by INTEGER, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sanctions_list (
  id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, name_norm TEXT NOT NULL, dob TEXT, source TEXT,
  added_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, owner_type TEXT NOT NULL, owner_id INTEGER NOT NULL, kind TEXT NOT NULL,
  original_name TEXT, mime TEXT, stored_name TEXT NOT NULL, size INTEGER, caption TEXT,
  created_by INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_owner ON files(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, customer_no TEXT UNIQUE NOT NULL, branch_id INTEGER NOT NULL REFERENCES branches(id),
  surname TEXT NOT NULL, given_names TEXT NOT NULL, dob TEXT NOT NULL, sex TEXT, marital_status TEXT, citizenship TEXT,
  home_province TEXT, home_district TEXT, home_village TEXT,
  mobile TEXT NOT NULL, mobile_network TEXT, mobile_verified_at TEXT, mobile_code_hash TEXT, mobile_code_expires TEXT,
  second_phone TEXT, email TEXT,
  addr_province TEXT, addr_district TEXT, addr_town TEXT, addr_section_lot TEXT, addr_landmark TEXT, po_box TEXT,
  residence_proof_type TEXT,
  employer TEXT, occupation TEXT, usual_income INTEGER,
  bank_name TEXT, bank_account_enc TEXT, mobile_banking_enc TEXT,
  nok_name TEXT, nok_relationship TEXT, nok_phone TEXT, nok_address TEXT,
  consent_terms_at TEXT, consent_data_at TEXT, consent_forfeit_at TEXT,
  sms_language TEXT NOT NULL DEFAULT 'en' CHECK (sms_language IN ('en','tpi')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blacklisted','deceased','inactive')),
  risk_grade TEXT NOT NULL DEFAULT 'standard',
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  duplicate_reason TEXT, duplicate_of INTEGER, duplicate_reviewed_by INTEGER, duplicate_reviewed_at TEXT,
  name_norm TEXT, mobile_norm TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS customers_mobile ON customers(mobile_norm);
CREATE INDEX IF NOT EXISTS customers_name ON customers(name_norm, dob);

CREATE TABLE IF NOT EXISTS customer_ids (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), id_type_id INTEGER NOT NULL REFERENCES id_types(id),
  number_enc TEXT NOT NULL, number_hash TEXT NOT NULL, number_last4 TEXT,
  issued_by TEXT, issue_date TEXT, expiry_date TEXT, name_on_id TEXT NOT NULL, dob_on_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  name_check TEXT, photo_match INTEGER, check_note TEXT, checked_by INTEGER, checked_at TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_ids_hash ON customer_ids(number_hash);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, item_no TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  category TEXT NOT NULL CHECK (category IN ('car','laptop','phone')),
  brand_id INTEGER REFERENCES brands(id), brand_name TEXT NOT NULL, model TEXT NOT NULL, colour TEXT, year INTEGER,
  storage TEXT, ram TEXT, processor TEXT,
  vin TEXT, engine_no TEXT, plate TEXT, serial_no TEXT, imei TEXT, device_password_enc TEXT,
  faults TEXT, accessories TEXT, intake_checks TEXT,
  owner_name TEXT NOT NULL, ownership_doc_type TEXT,
  mileage_intake INTEGER, fuel_intake TEXT,
  custody_status TEXT NOT NULL DEFAULT 'in_store'
    CHECK (custody_status IN ('in_store','for_sale','sold','returned','handed_back','missing')),
  location TEXT, safe_location TEXT,
  received_by INTEGER, date_in TEXT NOT NULL,
  returned_at TEXT, returned_to TEXT, return_id_shown TEXT, return_mileage INTEGER, return_note TEXT,
  current_loan_id INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS item_movements (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), from_location TEXT, to_location TEXT,
  from_status TEXT, to_status TEXT, reason TEXT, moved_by INTEGER, moved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS car_viewings (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), visitor TEXT NOT NULL, staff_id INTEGER NOT NULL,
  at TEXT NOT NULL, note TEXT
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY, loan_no TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id), loan_officer_id INTEGER NOT NULL, cro_id INTEGER,
  status TEXT NOT NULL,
  requested_amount INTEGER NOT NULL, approved_amount INTEGER, amount_released INTEGER,
  weekly_rate INTEGER, rate_grade TEXT, assessed_value_total INTEGER, max_loan_total INTEGER, ltv_pct REAL,
  fees_total INTEGER NOT NULL DEFAULT 0, fee_lines TEXT,
  interest_added INTEGER NOT NULL DEFAULT 0, fees_added INTEGER NOT NULL DEFAULT 0, total_paid INTEGER NOT NULL DEFAULT 0,
  principal_owing INTEGER NOT NULL DEFAULT 0, interest_owing INTEGER NOT NULL DEFAULT 0, fees_owing INTEGER NOT NULL DEFAULT 0,
  waived_total INTEGER NOT NULL DEFAULT 0,
  application_date TEXT NOT NULL, submitted_at TEXT, approval_date TEXT, release_date TEXT,
  release_channel TEXT, release_ref TEXT, next_interest_date TEXT, maturity_date TEXT, grace_end_date TEXT,
  date_closed TEXT, expiry_date TEXT, archive_date TEXT,
  archived INTEGER NOT NULL DEFAULT 0, archive_hold INTEGER NOT NULL DEFAULT 0, pre_archive_status TEXT,
  terms_snapshot TEXT, decision_note TEXT,
  forfeited_at TEXT, forfeited_by INTEGER, owing_at_forfeiture INTEGER,
  sale_total INTEGER, surplus INTEGER, shortfall INTEGER,
  dispute_open INTEGER NOT NULL DEFAULT 0, dispute_note TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS loans_status ON loans(status, archived);
CREATE TABLE IF NOT EXISTS loan_items (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), item_id INTEGER NOT NULL REFERENCES items(id),
  schedule_no TEXT,
  checklist TEXT, inspection_faults TEXT, grade TEXT, market_value INTEGER, repair_cost INTEGER, assessed_value INTEGER,
  share_pct INTEGER, max_loan INTEGER, rate_min INTEGER, rate_max INTEGER,
  ownership_verified INTEGER NOT NULL DEFAULT 0, ownership_note TEXT,
  valued_by INTEGER, valued_at TEXT, UNIQUE(loan_id, item_id)
);
CREATE TABLE IF NOT EXISTS interest_entries (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), entry_date TEXT NOT NULL,
  principal_owed INTEGER NOT NULL, rate INTEGER NOT NULL, amount INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'weekly' CHECK (kind IN ('weekly','adjustment')), note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interest_loan ON interest_entries(loan_id, entry_date);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, receipt_no TEXT UNIQUE NOT NULL, loan_id INTEGER NOT NULL REFERENCES loans(id),
  amount INTEGER NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('cash','bank','mobile')), reference TEXT,
  date_received TEXT NOT NULL, posted_by INTEGER NOT NULL, posted_at TEXT NOT NULL,
  applied_fees INTEGER NOT NULL DEFAULT 0, applied_interest INTEGER NOT NULL DEFAULT 0, applied_principal INTEGER NOT NULL DEFAULT 0,
  overpayment INTEGER NOT NULL DEFAULT 0, balance_after INTEGER,
  kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','reversal')),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_of INTEGER, unmatched_id INTEGER
);
CREATE TABLE IF NOT EXISTS unmatched_payments (
  id INTEGER PRIMARY KEY, branch_id INTEGER, amount INTEGER NOT NULL, channel TEXT NOT NULL, reference TEXT,
  date_received TEXT NOT NULL, payer_name TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched')),
  matched_loan_id INTEGER, matched_payment_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL,
  matched_by INTEGER, matched_at TEXT
);
CREATE TABLE IF NOT EXISTS reversal_requests (
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id), loan_id INTEGER NOT NULL,
  reason TEXT NOT NULL, requested_by INTEGER NOT NULL, requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER, decided_at TEXT, decision_note TEXT
);
CREATE TABLE IF NOT EXISTS waivers (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), kind TEXT NOT NULL CHECK (kind IN ('interest','fees')),
  amount INTEGER NOT NULL, applied_amount INTEGER, reason TEXT NOT NULL, requested_by INTEGER NOT NULL, requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER, decided_at TEXT, effective_date TEXT, decision_note TEXT
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), payment_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('overpayment','surplus')), amount INTEGER NOT NULL, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'owed' CHECK (status IN ('owed','paid')),
  channel TEXT, reference TEXT, paid_by INTEGER, paid_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loan_events (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), type TEXT NOT NULL,
  from_status TEXT, to_status TEXT, note TEXT, user_id INTEGER, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loan_events_loan ON loan_events(loan_id);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), ticket_no TEXT NOT NULL, version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original','replacement')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','expired','redeemed','closed')),
  id_shown TEXT, reason TEXT, printed_by INTEGER, printed_at TEXT NOT NULL, cancelled_at TEXT
);
CREATE TABLE IF NOT EXISTS forfeiture_sales (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loans(id), item_id INTEGER NOT NULL REFERENCES items(id),
  status TEXT NOT NULL DEFAULT 'awaiting_reserve' CHECK (status IN ('awaiting_reserve','approved','listed','sold')),
  reserve_price INTEGER, reserve_approved_by INTEGER, reserve_approved_at TEXT,
  auction_platform TEXT, listing_ref TEXT, listed_at TEXT, auction_result TEXT,
  sale_method TEXT, sale_date TEXT, sale_price INTEGER, buyer_name TEXT, buyer_contact TEXT, sale_receipt_no TEXT,
  recorded_by INTEGER, recorded_at TEXT, forfeited_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive (
  id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL, loan_no TEXT NOT NULL, snapshot TEXT NOT NULL,
  search_text TEXT, archived_at TEXT NOT NULL, archived_by INTEGER, method TEXT NOT NULL, reason TEXT,
  restored_at TEXT, restored_by INTEGER, restore_reason TEXT, delete_after TEXT
);
CREATE TABLE IF NOT EXISTS deletion_log (id INTEGER PRIMARY KEY, loan_no TEXT NOT NULL, deleted_on TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL, period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','signed_off','reviewed')),
  counted_by INTEGER, started_at TEXT NOT NULL, submitted_at TEXT, cro_id INTEGER, signed_at TEXT, cro_note TEXT,
  admin_id INTEGER, reviewed_at TEXT, admin_note TEXT, missing_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(branch_id, period)
);
CREATE TABLE IF NOT EXISTS stock_count_lines (
  id INTEGER PRIMARY KEY, count_id INTEGER NOT NULL REFERENCES stock_counts(id), item_id INTEGER NOT NULL,
  expected_location TEXT, found INTEGER NOT NULL DEFAULT 0, note TEXT
);
CREATE TABLE IF NOT EXISTS store_access (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL, area TEXT NOT NULL, action TEXT NOT NULL, user_id INTEGER NOT NULL,
  at TEXT NOT NULL, note TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER, role TEXT, branch_id INTEGER, title TEXT NOT NULL, body TEXT, link TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_reads (notification_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (notification_id, user_id));
CREATE TABLE IF NOT EXISTS sms_outbox (
  id INTEGER PRIMARY KEY, to_number TEXT NOT NULL, language TEXT NOT NULL, template TEXT NOT NULL, body TEXT NOT NULL,
  customer_id INTEGER, loan_id INTEGER, user_id INTEGER, status TEXT NOT NULL DEFAULT 'queued', error TEXT,
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, loan_id INTEGER, customer_id INTEGER, branch_id INTEGER, role TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', outcome TEXT, due_date TEXT, created_at TEXT NOT NULL,
  done_by INTEGER, done_at TEXT
);
CREATE TABLE IF NOT EXISTS aml_flags (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, customer_id INTEGER, loan_id INTEGER, payment_id INTEGER, details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','reported')),
  reviewed_by INTEGER, reviewed_at TEXT, review_note TEXT, fasu_ref TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY, job TEXT NOT NULL, run_date TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  summary TEXT, triggered_by INTEGER
);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, size INTEGER, sha256 TEXT, created_at TEXT NOT NULL, copies TEXT,
  verified_at TEXT, verify_result TEXT
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user_id INTEGER, username TEXT, role TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, old_value TEXT, new_value TEXT, ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log(entity, entity_id);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'The audit log is read-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
WHEN old.ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 years')
BEGIN SELECT RAISE(ABORT, 'Audit entries can only be removed by the retention schedule'); END;
`;

function open(file = DB_FILE) {
  if (db) return db;
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Networks are now Digicel, Telikom and Vodafone (Vodafone numbers start with 8).
  db.prepare("UPDATE customers SET mobile_network = CASE WHEN mobile LIKE '8%' THEN 'Vodafone' ELSE 'Telikom' END WHERE mobile_network = 'Vodafone/bmobile'").run();
  return db;
}
function get() { return db || open(); }
function close() { if (db) { db.close(); db = null; } }

module.exports = { open, get, close };
