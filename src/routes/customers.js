'use strict';
const express = require('express');
const db = require('../db');
const customers = require('../services/customers');
const items = require('../services/items');
const files = require('../services/files');
const { checkBranch } = require('../lib/ctx');
const { Forbidden } = require('../lib/errors');

const r = express.Router();
const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : next(new Forbidden()));

r.get('/', (req, res) => {
  res.render('customers/list', { title: 'Customers', list: customers.search(req.ctx(), req.query.q), q: req.query.q || '' });
});

r.get('/new', only('loan_officer'), (req, res) => {
  res.render('customers/form', { title: 'New customer', c: {}, companyBank: require('../services/settings').companyBank(), PROVINCES: customers.PROVINCES, RESIDENCE: customers.RESIDENCE_PROOF });
});
function media(req) {
  return {
    photo1: req.filesOf('photo1'), photo2: req.filesOf('photo2'),
  };
}
r.post('/', only('loan_officer'), (req, res) => {
  const { id, duplicates } = customers.create(req.ctx(), req.body, media(req));
  if (duplicates.length) res.flash('error', 'Possible duplicate profile: it has been sent to the CRO and is blocked until reviewed.', duplicates.map((d) => `${d.why} as ${d.customer_no}`));
  else res.flash('success', 'Customer registered. Next: add the two IDs.');
  res.redirect(`/customers/${id}`);
});

function load(req) {
  const c = customers.get(req.params.id);
  checkBranch(req.ctx(), c.branch_id);
  return c;
}

r.get('/:id', (req, res) => {
  const c = load(req);
  const ctx = req.ctx();
  const ids = customers.ids(c.id).map((x) => ({ ...x, shown: customers.idNumberFor(ctx, x), scans: files.list('customer_id', x.id) }));
  const loanRows = db.get().prepare(`SELECT l.*, (l.principal_owing + l.interest_owing + l.fees_owing) owing FROM loans l WHERE customer_id = ? ORDER BY id DESC`).all(c.id)
    .map((l) => ({ ...l, items: db.get().prepare('SELECT i.brand_name, i.model FROM loan_items li JOIN items i ON i.id = li.item_id WHERE li.loan_id = ?').all(l.id).map((i) => `${i.brand_name} ${i.model}`).join(', ') }));
  res.render('customers/view', {
    title: `${c.given_names} ${c.surname}`, c, ids, loans: loanRows, items: items.forCustomer(c.id), available: items.available(c.id),
    photos: files.list('customer_photo', c.id),
    readiness: customers.loanReadiness(c.id, req.res.locals.today), complete: customers.profileComplete(c),
    idTypes: customers.idTypes(), mobile: customers.displayMobile(c.mobile),
    aml: db.get().prepare("SELECT * FROM aml_flags WHERE customer_id = ? AND status = 'open'").all(c.id),
  });
});

r.get('/:id/edit', only('loan_officer', 'cro'), (req, res) => {
  const c = load(req);
  res.render('customers/form', { title: `Edit ${c.customer_no}`, c, companyBank: require('../services/settings').companyBank(), PROVINCES: customers.PROVINCES, RESIDENCE: customers.RESIDENCE_PROOF });
});
r.post('/:id', only('loan_officer', 'cro'), (req, res) => {
  customers.update(req.ctx(), Number(req.params.id), req.body, media(req));
  res.flash('success', 'Profile saved.');
  res.redirect(`/customers/${req.params.id}`);
});

r.post('/:id/ids', only('loan_officer'), (req, res) => {
  customers.addId(req.ctx(), Number(req.params.id), req.body, { front: req.filesOf('front'), back: req.filesOf('back') });
  res.flash('success', 'ID added. The CRO has been asked to check it.');
  res.redirect(`/customers/${req.params.id}#ids`);
});
r.post('/:id/ids/:idId/review', only('cro'), (req, res) => {
  customers.reviewId(req.ctx(), Number(req.params.idId), { decision: req.body.decision, photo_match: !!req.body.photo_match, note: req.body.note });
  res.flash('success', `ID ${req.body.decision === 'accept' ? 'accepted' : 'rejected'}.`);
  res.redirect(`/customers/${req.params.id}#ids`);
});
r.post('/:id/duplicate', only('cro'), (req, res) => {
  customers.resolveDuplicate(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', req.body.decision === 'clear' ? 'Cleared: not a duplicate.' : 'Confirmed as duplicate; profile closed.');
  res.redirect(`/customers/${req.params.id}`);
});
r.post('/:id/status', only('cro'), (req, res) => {
  customers.setStatus(req.ctx(), Number(req.params.id), req.body);
  res.flash('success', 'Status updated.');
  res.redirect(`/customers/${req.params.id}`);
});

r.get('/:id/items/new', only('loan_officer'), (req, res) => {
  const c = load(req);
  const cat = items.CATEGORIES[req.query.category] ? req.query.category : null;
  const brands = cat ? db.get().prepare('SELECT * FROM brands WHERE category = ? AND active = 1 ORDER BY name').all(cat) : [];
  res.render('customers/item_form', { title: 'Receive item', c, cat, catDef: cat && items.CATEGORIES[cat], CATEGORIES: items.CATEGORIES, brands, minPhotos: require('../services/settings').get('min_item_photos') });
});
r.post('/:id/items', only('loan_officer'), (req, res) => {
  const id = items.intake(req.ctx(), Number(req.params.id), req.body, { sides: req.filesOf('photos'), extra: req.filesOf('extra_photo') }, req.filesOf('ownership'));
  res.flash('success', 'Item received, tagged and stored. Print the tag and attach it.');
  res.redirect(`/items/${id}`);
});

module.exports = r;
