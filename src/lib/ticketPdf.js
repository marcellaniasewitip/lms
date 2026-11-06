'use strict';
// The pledge ticket as a PDF, laid out like the printed Kinaboy ticket: heading, Our details,
// Your details, amounts and dates, company description, "Signed by" lines, Schedule 1 – The
// Goods; then the Disclosure Statement. Two copies (customer's and lender's). Built with
// PDFKit, so the server needs no browser to make it.
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const A4 = { w: 595.28, h: 841.89 };
const M = 34; // page margin
const CAT = { phone: 'ELECTRONIC PHONE', laptop: 'ELECTRONIC LAPTOP', car: 'MOTOR VEHICLE' };

function pick(t0, cur, k) { return (t0[k] && t0[k].length ? t0[k] : cur[k]) || []; }

async function build(d) {
  const { l, c, t, branch, officer, lis, fig, idText, bank, current: cur, fd, K, fmtPhone } = d;
  const t0 = fig.terms;
  const months = t0.term_months || cur.term_months;
  const expired = t && t.status === 'expired';
  const replacement = t && t.kind === 'replacement';
  const barcode = await bwipjs.toBuffer({ bcid: 'code128', text: l.loan_no, scale: 2, height: 9, includetext: true, textxalign: 'center' });
  const addr = [c.addr_section_lot, c.addr_town, c.addr_district, c.addr_province].filter(Boolean).join(', ');

  const doc = new PDFDocument({ size: 'A4', margin: M, info: { Title: `Pledge ticket ${l.loan_no}`, Author: cur.lender_name } });
  const chunks = [];
  doc.on('data', (x) => chunks.push(x));
  const done = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const W = A4.w - 2 * M;

  const center = (text, font, size, y) => { doc.font(font).fontSize(size); doc.text(text, M, y, { width: W, align: 'center', lineBreak: false }); };
  const rule = (y, wgt) => { doc.save().lineWidth(wgt).moveTo(M, y).lineTo(A4.w - M, y).stroke().restore(); };

  function stamps() {
    if (expired) {
      doc.save().rotate(-8, { origin: [A4.w - 90, 40] }).lineWidth(2).strokeColor('#aa0000').fillColor('#aa0000')
        .rect(A4.w - 140, 22, 100, 30).stroke().font('Helvetica-Bold').fontSize(20).text('EXPIRED', A4.w - 140, 28, { width: 100, align: 'center' }).restore();
      doc.fillColor('#000').strokeColor('#000');
    }
    if (replacement) {
      doc.save().rotate(-14, { origin: [A4.w / 2, A4.h / 2] }).fillColor('#aa0000').opacity(0.18).font('Helvetica-Bold').fontSize(64)
        .text('REPLACEMENT', 0, A4.h / 2 - 40, { width: A4.w, align: 'center' }).restore();
      doc.opacity(1).fillColor('#000');
    }
  }

  function ticketPage() {
    stamps();
    // Heading: NAME | slogan, centred
    const brand = cur.ticket_brand || cur.lender_name;
    doc.font('Helvetica-Bold').fontSize(26); const bw = doc.widthOfString(brand);
    doc.font('Helvetica').fontSize(26); const sep = '  |  '; const sw = doc.widthOfString(sep);
    doc.font('Helvetica-Oblique').fontSize(20); const slw = cur.lender_slogan ? doc.widthOfString(cur.lender_slogan) : 0;
    let x = M + (W - (bw + (cur.lender_slogan ? sw + slw : 0))) / 2;
    doc.font('Helvetica-Bold').fontSize(26).text(brand, x, M, { lineBreak: false });
    if (cur.lender_slogan) {
      doc.font('Helvetica').fontSize(26).text(sep, x + bw, M, { lineBreak: false });
      doc.font('Helvetica-Oblique').fontSize(20).text(cur.lender_slogan, x + bw + sw, M + 5, { lineBreak: false });
    }
    center('PLEDGE TICKET FOR GOODS DETAILS IN SCHEDULE 1 – ATTACHED ("the Goods")', 'Helvetica-Bold', 10, M + 36);
    center('Required by the Pawnbrokers Act 1951 ("PBA")', 'Helvetica', 9.5, M + 49);

    // Our details / Your details
    let y = M + 70;
    const block = (title, rows) => {
      doc.font('Helvetica').fontSize(10).text(title, M, y, { lineBreak: false });
      for (const [label, value, note] of rows) {
        doc.font('Helvetica').fontSize(9).text(label, M + 90, y, { width: 110 });
        const vy = y;
        doc.font('Helvetica').fontSize(9).text(value || '—', M + 205, vy, { width: W - 205 });
        y = Math.max(doc.y, vy + 11);
        if (note) { doc.font('Helvetica-Oblique').fontSize(9).text(note, M + 205, y, { width: W - 205 }); y = doc.y; }
      }
      y += 6;
    };
    block('Our details', [
      ['Name:', `${branch.name} ("we", "us", "our")`], ['Phone:', branch.phone], ['Email:', branch.email],
      ['Postal Address:', branch.postal_address, 'This is where you can redeem your goods.'], ['Physical Address:', branch.physical_address],
    ]);
    block('Your details', [
      ['Postal Address:', c.po_box], ['Name:', `${c.given_names} ${c.surname}`], ['Residential:', addr], ['Phone:', fmtPhone(c.mobile)],
      ['ID:', idText], ['Date of Birth:', `${fd(c.dob)}  (Note you must be 18 years or over to pledge goods)`],
    ]);
    rule(y, 2.5); y += 8;

    // Amounts and dates, in two columns
    const half = W / 2 - 15;
    const pair = (cx, label, value, bold) => {
      doc.font('Helvetica').fontSize(10).text(label, cx, y, { width: half - 90 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(value, cx + half - 90, y, { width: 90, align: 'right' });
    };
    pair(M, 'Amount Advanced', K(fig.amount)); pair(M + W / 2 + 15, 'Contract Number', l.loan_no, true); y += 15;
    pair(M, 'Redemption Fee', K(fig.weeklyCharge)); pair(M + W / 2 + 15, 'Contract Date', fd(fig.release)); y += 15;
    pair(M, 'Amount Payable at Redemption', K(fig.price), true); pair(M + W / 2 + 15, 'Redemption Date', fd(fig.redemptionDate), true); y += 12;
    doc.font('Helvetica').fontSize(10).text('(Redemption Price)', M, y); y += 17;
    doc.font('Helvetica').fontSize(8).text(`A lesser amount may be payable if you redeem the Goods before the Redemption Date. ${fd(fig.redemptionDate)}`, M, y, { width: half });
    pair(M + W / 2 + 15, 'Redemption Period', `${months} months`);
    y = Math.max(doc.y, y + 12) + 6;
    rule(y, 0.8); y += 6;

    // Company description
    const list = (items, numbered, indent) => {
      items.forEach((txt, n) => {
        const mark = numbered ? `${n + 1}.` : '–';
        doc.font('Helvetica').fontSize(7.6).text(mark, M + indent, y, { width: 14 });
        doc.text(txt, M + indent + 14, y, { width: W - indent - 14 });
        y = doc.y + 1;
      });
    };
    list(pick(t0, cur, 'pledge_terms').map((x) => x.replace(/\{months\}/g, months)), true, 0);
    doc.font('Helvetica').fontSize(7.6).text('By signing below, you agree and confirm:', M + 14, y); y = doc.y + 1;
    list(pick(t0, cur, 'pledge_confirmations'), true, 0);
    doc.font('Helvetica-Oblique').fontSize(7.6).text('Summary of Rights of Pledgers and Obligations of Pawnbrokers under the pledge, as provided by the PBA', M, y); y = doc.y + 1;
    doc.font('Helvetica').fontSize(7.6).text('Rights of Pledgers', M + 14, y); y = doc.y;
    list(pick(t0, cur, 'pledge_rights'), false, 22);
    doc.font('Helvetica').fontSize(7.6).text('Obligations of Pawnbrokers', M + 14, y); y = doc.y;
    list(pick(t0, cur, 'pledge_obligations'), false, 22);

    // Signatures
    y += 30;
    const sigW = W / 2 - 40;
    doc.lineWidth(0.8).moveTo(M, y).lineTo(M + sigW, y).stroke();
    doc.moveTo(A4.w - M - sigW, y).lineTo(A4.w - M, y).stroke();
    doc.font('Helvetica').fontSize(10).text(`Signed by: ${c.given_names} ${c.surname}`, M, y + 4, { width: sigW });
    doc.text(`Signed by: ${officer || ''}`, A4.w - M - sigW, y + 4, { width: sigW });
    y += 24;

    // Schedule 1 – The Goods
    doc.image(barcode, A4.w - M - 80, y, { width: 80 });
    doc.font('Helvetica-Oblique').fontSize(10).text('Schedule 1 – The Goods', M, y); y = doc.y;
    for (const i of lis) {
      const acc = JSON.parse(i.accessories || '[]');
      doc.font('Helvetica').fontSize(10).text(`Item number ${i.schedule_no}`, M, y); y = doc.y;
      const lines = [
        `${CAT[i.category]}, ${i.brand_name} ${i.model}` + (i.category === 'car'
          ? `${i.year ? ', ' + i.year : ''}${i.colour ? ', ' + i.colour : ''}, odometer ${Number(i.mileage_intake).toLocaleString('en-US')} km`
          : `${i.storage ? ', ' + i.storage : ''}${i.ram ? ', ' + i.ram + ' RAM' : ''}${i.processor ? ', ' + i.processor : ''}`),
        i.category === 'car' ? `VIN: ${i.vin}, Engine: ${i.engine_no}, Plate: ${i.plate}` : i.imei ? `IMEI: ${i.imei}` : `SN: ${i.serial_no}`,
        (acc.length ? `Comes with ${acc.join(', ')}` : 'No accessories') + (i.category === 'car' ? '' : ` and pw: ${i.password}`),
      ];
      for (const ln of lines) { doc.fontSize(10).text('•', M + 4, y, { width: 10 }); doc.text(ln, M + 18, y, { width: W - 110 }); y = doc.y; }
    }
  }

  function disclosurePage(copy) {
    stamps();
    doc.font('Helvetica-Bold').fontSize(16).text('Disclosure Statement', M, M);
    doc.font('Helvetica').fontSize(9.5).text(`Contract ${l.loan_no} · ${cur.lender_name} · ${copy}`, M, doc.y + 2);
    let y = doc.y + 10;
    const fl = JSON.parse(l.fee_lines || '[]');
    const rows = [
      ['Amount advanced', K(fig.amount)],
      ['Weekly interest rate', `${l.weekly_rate}% a week on the principal still owed (set by the item's quality grade ${l.rate_grade || ''})`],
      ['Interest for a full week on the amount advanced', K(fig.weeklyCharge)],
      ...(bank.any ? [['Where to pay', `Cash at ${branch.name}, or bank deposit / mobile transfer to ${bank.text}, quoting contract number ${l.loan_no}.`]] : []),
      ['Fees', fl.length ? fl.map((f) => `${f.name} ${K(f.amount)}`).join('; ') : 'None'],
      [`Redemption price if nothing is paid before ${fd(fig.redemptionDate)}`, K(fig.price)],
      ['Maturity (redemption) date', `${fd(fig.redemptionDate)} — no renewals or extensions`],
      ['Grace period', `${t0.grace_days} days to ${fd(fig.graceEnd)}; interest keeps being added each week`],
      ['If not paid by the grace end date', 'The goods are forfeited and sold at a public internet auction (or by other reasonable means). Any surplus over the amount owing is paid to you as section 19 of the Pawnbrokers Act 1951 requires.'],
      ['Example of early redemption', `Paying in full after 2 weeks with no part payments costs ${K(fig.amount + 2 * fig.weeklyCharge + fig.fees)}.`],
    ];
    for (const [k, v] of rows) {
      const top = y;
      doc.font('Helvetica-Bold').fontSize(9.5).text(k, M + 6, y + 4, { width: 190 });
      const h1 = doc.y;
      doc.font('Helvetica').fontSize(9.5).text(v, M + 210, y + 4, { width: W - 216 });
      y = Math.max(h1, doc.y) + 4;
      doc.lineWidth(0.5).rect(M, top, W, y - top).stroke();
      doc.moveTo(M + 204, top).lineTo(M + 204, y).stroke();
    }
    doc.font('Helvetica').fontSize(9.5).text(t0.disclosure_extra || cur.disclosure_extra || '', M, y + 10, { width: W });
    y = doc.y + 50;
    const sigW = W / 2 - 40;
    doc.lineWidth(0.8).moveTo(M, y).lineTo(M + sigW, y).stroke().moveTo(A4.w - M - sigW, y).lineTo(A4.w - M, y).stroke();
    doc.font('Helvetica').fontSize(10).text(`Signed by: ${c.given_names} ${c.surname}`, M, y + 4, { width: sigW });
    doc.text(`Signed by: ${officer || ''}`, A4.w - M - sigW, y + 4, { width: sigW });
  }

  ['Customer\'s copy', 'Lender\'s copy'].forEach((copy, n) => {
    if (n) doc.addPage();
    ticketPage();
    doc.addPage();
    disclosurePage(copy);
  });
  doc.end();
  return done;
}

module.exports = { build };
