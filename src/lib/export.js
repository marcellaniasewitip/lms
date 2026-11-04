'use strict';
// Excel and PDF export for reports and archived loans.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const dates = require('./dates');
const money = require('./money');

function cell(col, v) {
  if (v === null || v === undefined) return '';
  if (col.type === 'money') return money.fmt(v);
  if (col.type === 'date') return dates.fmt(v);
  return String(v);
}

async function reportToXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Loan Management System';
  for (const [n, s] of report.sections.entries()) {
    const ws = wb.addWorksheet(`${n + 1} ${s.title}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31));
    ws.addRow([report.title]).font = { bold: true, size: 13 };
    ws.addRow([s.title]).font = { bold: true };
    const hr = ws.addRow(s.columns.map((c) => c.label + (c.type === 'money' ? ' (K)' : '')));
    hr.font = { bold: true };
    for (const r of s.rows) {
      ws.addRow(s.columns.map((c) => {
        const v = r[c.key];
        if (v === null || v === undefined) return '';
        if (c.type === 'money') return money.num(v);
        if (c.type === 'date') return dates.fmt(v);
        return v;
      }));
    }
    s.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(10, Math.min(40, c.label.length + 6)); if (c.type === 'money') ws.getColumn(i + 1).numFmt = '#,##0.00'; });
  }
  return wb.xlsx.writeBuffer();
}

function pdfBuffer(build) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    build(doc);
    doc.end();
  });
}

function table(doc, columns, rows, cellFn = cell) {
  const width = doc.page.width - 72;
  const w = width / columns.length;
  const drawHeader = () => {
    doc.font('Helvetica-Bold').fontSize(7.5);
    const y = doc.y;
    columns.forEach((c, i) => doc.text(c.label, 36 + i * w, y, { width: w - 4 }));
    doc.moveDown(0.3);
    doc.moveTo(36, doc.y).lineTo(36 + width, doc.y).strokeColor('#999').stroke();
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(7.5);
  };
  drawHeader();
  if (!rows.length) { doc.text('None.', 36); doc.moveDown(); return; }
  for (const r of rows) {
    const vals = columns.map((c) => cellFn(c, r[c.key]));
    const h = Math.max(...vals.map((v) => doc.heightOfString(v || ' ', { width: w - 4 })));
    if (doc.y + h > doc.page.height - 40) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    vals.forEach((v, i) => doc.text(v, 36 + i * w, y, { width: w - 4 }));
    doc.y = y + h + 2;
  }
  doc.moveDown();
}

function reportToPdf(report, lender) {
  return pdfBuffer((doc) => {
    doc.font('Helvetica-Bold').fontSize(14).text(report.title, 36);
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`${lender} · printed ${dates.fmtTs(new Date().toISOString())} (Port Moresby) ${report.scopeNote || ''}`);
    doc.fillColor('#000').moveDown();
    for (const s of report.sections) {
      if (doc.y > doc.page.height - 100) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).text(s.title, 36);
      doc.moveDown(0.3);
      table(doc, s.columns, s.rows);
    }
  });
}

// Read-only archived loan exported as PDF from its locked snapshot.
function archivedLoanToPdf(snap, meta, lender, statusLabel) {
  const l = snap.loan;
  return pdfBuffer((doc) => {
    doc.font('Helvetica-Bold').fontSize(14).text(`Archived loan ${l.loan_no}`, 36);
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text(`${lender} · archived ${dates.fmtTs(meta.archived_at)} (${meta.method}${meta.reason ? ': ' + meta.reason : ''}) · keep until ${dates.fmt(meta.delete_after)}`);
    doc.fillColor('#000').moveDown();
    const kv = [
      ['Customer', `${snap.customer.name} (${snap.customer.customer_no}), born ${dates.fmt(snap.customer.dob)}`],
      ['Outcome', statusLabel(l.pre_archive_status)], ['Amount released', money.fmt(l.amount_released)], ['Weekly rate', l.weekly_rate ? `${l.weekly_rate}% (grade ${l.rate_grade})` : ''],
      ['Assessed value', money.fmt(l.assessed_value_total)], ['Interest added', money.fmt(l.interest_added)], ['Total paid', money.fmt(l.total_paid)],
      ['Application', dates.fmt(l.application_date)], ['Approved', dates.fmt(l.approval_date)], ['Released', dates.fmt(l.release_date)],
      ['Maturity', dates.fmt(l.maturity_date)], ['Grace end', dates.fmt(l.grace_end_date)], ['Closed', dates.fmt(l.date_closed)], ['Expiry', dates.fmt(l.expiry_date)],
      ['Archived', dates.fmt(l.archive_date)], ['Sale total / surplus / shortfall', l.sale_total ? `${money.fmt(l.sale_total)} / ${money.fmt(l.surplus)} / ${money.fmt(l.shortfall)}` : '—'],
    ];
    doc.fontSize(9);
    for (const [k, v] of kv) { doc.font('Helvetica-Bold').text(k + ': ', 36, doc.y, { continued: true }).font('Helvetica').text(v || '—'); }
    doc.moveDown();
    const sect = (t, cols, rows, fn) => { if (doc.y > doc.page.height - 100) doc.addPage(); doc.font('Helvetica-Bold').fontSize(10).text(t, 36); doc.moveDown(0.3); table(doc, cols, rows, fn); };
    sect('Items', [{ key: 'schedule_no', label: 'Sched. no' }, { key: 'item_no', label: 'Tag' }, { key: 'category', label: 'Category' }, { key: 'brand_name', label: 'Brand' },
      { key: 'model', label: 'Model' }, { key: 'grade', label: 'Grade' }, { key: 'assessed_value', label: 'Assessed', type: 'money' }, { key: 'custody_status', label: 'Outcome' }, { key: 'returned_to', label: 'Returned to' }], snap.items);
    sect('Interest entries', [{ key: 'entry_date', label: 'Date', type: 'date' }, { key: 'principal_owed', label: 'Principal owed', type: 'money' }, { key: 'rate', label: 'Rate %' },
      { key: 'amount', label: 'Interest', type: 'money' }, { key: 'kind', label: 'Kind' }], snap.interest);
    sect('Payments', [{ key: 'receipt_no', label: 'Receipt' }, { key: 'date_received', label: 'Received', type: 'date' }, { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'channel', label: 'Channel' }, { key: 'reference', label: 'Reference' }, { key: 'status', label: 'Status' }, { key: 'posted_by_name', label: 'Posted by' }], snap.payments);
    sect('History', [{ key: 'at', label: 'When' }, { key: 'type', label: 'Event' }, { key: 'to_status', label: 'Status' }, { key: 'note', label: 'Note' }, { key: 'user_name', label: 'By' }],
      snap.history, (c, v) => (c.key === 'at' ? dates.fmtTs(v) : cell(c, v)));
  });
}

module.exports = { reportToXlsx, reportToPdf, archivedLoanToPdf };
