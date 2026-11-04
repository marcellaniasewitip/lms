/* Loan Management System — small client helpers (no inline scripts; CSP friendly). */
(function () {
  'use strict';

  // Idle logout after the configured minutes without activity.
  const idle = Number(document.body.dataset.idle || 0);
  if (idle && document.body.dataset.auth === '1') {
    let t;
    const reset = () => { clearTimeout(t); t = setTimeout(() => { window.location = '/login?idle=1'; }, idle * 60000); };
    ['click', 'keydown', 'mousemove', 'touchstart'].forEach((e) => document.addEventListener(e, reset, { passive: true }));
    reset();
  }

  // Confirm dangerous actions.
  document.querySelectorAll('[data-confirm]').forEach((el) => {
    el.addEventListener('submit', (e) => { if (!window.confirm(el.dataset.confirm)) e.preventDefault(); });
  });

  // Print buttons.
  document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));

  // Live photo capture from the branch camera, stored into a hidden field as a data URL.
  document.querySelectorAll('[data-camera]').forEach((box) => {
    const video = box.querySelector('video');
    const canvas = box.querySelector('canvas');
    const field = document.getElementById(box.dataset.camera);
    const start = box.querySelector('[data-start]');
    const snap = box.querySelector('[data-snap]');
    start && start.addEventListener('click', async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        video.srcObject = s; video.play(); snap.disabled = false;
      } catch (e) { alert('Camera not available: use the file upload instead. (' + e.message + ')'); }
    });
    snap && snap.addEventListener('click', () => {
      canvas.width = 640; canvas.height = 480;
      canvas.getContext('2d').drawImage(video, 0, 0, 640, 480);
      field.value = canvas.toDataURL('image/jpeg', 0.85);
      canvas.style.display = 'block';
      box.querySelector('[data-status]').textContent = 'Photo captured ✓';
    });
  });

  // Signature pad.
  document.querySelectorAll('canvas.sig').forEach((c) => {
    const field = document.getElementById(c.dataset.field);
    const ctx = c.getContext('2d');
    const fit = () => { const r = c.getBoundingClientRect(); c.width = r.width; c.height = r.height; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111'; };
    fit();
    let down = false, drew = false;
    const pos = (e) => { const r = c.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return [p.clientX - r.left, p.clientY - r.top]; };
    const startDraw = (e) => { down = true; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); e.preventDefault(); };
    const move = (e) => { if (!down) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); drew = true; e.preventDefault(); };
    const end = () => { if (down && drew) field.value = c.toDataURL('image/png'); down = false; };
    c.addEventListener('mousedown', startDraw); c.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
    c.addEventListener('touchstart', startDraw); c.addEventListener('touchmove', move); c.addEventListener('touchend', end);
    const clear = document.querySelector(`[data-clear="${c.dataset.field}"]`);
    clear && clear.addEventListener('click', () => { ctx.clearRect(0, 0, c.width, c.height); field.value = ''; drew = false; });
  });

  // Category select on the item intake page reloads the form for that category.
  document.querySelectorAll('[data-goto]').forEach((s) => s.addEventListener('change', () => { window.location = s.dataset.goto + encodeURIComponent(s.value); }));

  // Show/hide fields that depend on a radio or select value.
  document.querySelectorAll('[data-show-when]').forEach((el) => {
    const [name, value] = el.dataset.showWhen.split('=');
    const inputs = document.querySelectorAll(`[name="${name}"]`);
    const upd = () => {
      let v = '';
      inputs.forEach((i) => { if ((i.type === 'radio' || i.type === 'checkbox') ? i.checked : true) v = i.value; });
      el.style.display = v === value ? '' : 'none';
    };
    inputs.forEach((i) => i.addEventListener('change', upd)); upd();
  });

  // Live total for valuation: assessed = market - repairs; max = assessed * share.
  const val = document.querySelector('[data-valuation]');
  if (val) {
    const shares = JSON.parse(val.dataset.valuation);
    const parse = (s) => Number(String(s || '0').replace(/[K,\s]/gi, '')) || 0;
    const out = val.querySelector('[data-out]');
    const upd = () => {
      const m = parse(val.querySelector('[name=market_value]').value), r = parse(val.querySelector('[name=repair_cost]').value);
      const g = (val.querySelector('[name=grade]:checked') || {}).value;
      const a = Math.max(0, m - r), s = shares[g] || 0;
      const f = (n) => 'K' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      out.textContent = g ? `Assessed value ${f(a)} × ${s}% = maximum loan ${f(Math.floor(a * s) / 100)}` : 'Choose a grade';
    };
    val.addEventListener('input', upd); val.addEventListener('change', upd); upd();
  }

  // Show the mobile network as the number is typed (prefixes as in src/lib/phone.js).
  const netIn = document.querySelector('[data-network-in]'), netOut = document.querySelector('[data-network-out]');
  if (netIn && netOut) {
    const NETS = { Digicel: ['70', '71', '72', '73', '74', '79'], Telikom: ['75', '76', '78'], Vodafone: ['81', '82', '83'] };
    const upd = () => {
      let n = netIn.value.replace(/\D/g, '');
      if (n.startsWith('675') && n.length === 11) n = n.slice(3);
      const net = Object.keys(NETS).find((k) => NETS[k].includes(n.slice(0, 2)));
      netOut.value = n.length === 8 && net ? net : n.length >= 2 && !net ? 'Not a PNG mobile prefix' : '';
    };
    netIn.addEventListener('input', upd); upd();
  }

  // Autofocus scan fields (barcode scanners type then press Enter).
  const scan = document.querySelector('[data-scan]');
  if (scan) scan.focus();
})();
