'use strict';
// Shared helpers for services: role checks and branch scoping.
const { Forbidden } = require('./errors');

const ROLE_LABEL = { admin: 'Admin', loan_officer: 'Loan Officer', cro: 'CRO (Credit Risk Officer)' };

function requireRole(ctx, ...roles) {
  if (!ctx || !ctx.user || !roles.includes(ctx.user.role)) {
    throw new Forbidden(`This action is for ${roles.map((r) => ROLE_LABEL[r]).join(' or ')} only.`);
  }
}
// Loan Officers and CROs work within their own branch; Admin sees every branch.
function checkBranch(ctx, branchId) {
  const u = ctx.user;
  if (u && u.role !== 'admin' && u.branch_id && branchId && u.branch_id !== branchId) {
    throw new Forbidden('This record belongs to another branch.');
  }
}
function today(ctx) { return (ctx && ctx.today) || require('./dates').today(); }

module.exports = { requireRole, checkBranch, today, ROLE_LABEL };
