'use strict';
// UI smoke test: signs in as each role (password + SMS code) and opens every screen,
// failing on any server error. Run against a server started on demo data:
//   node scripts/seed.js --reset && npm start   (in another terminal)
//   node tests/smoke-ui.js [baseUrl] [screenshotDir]
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:3000';
const SHOTS = process.argv[3] || null;

async function login(page, username) {
  await page.goto(BASE + '/login');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'Demo#Pass2026');
  await page.click('button:has-text("Continue")');
  const code = (await page.textContent('.alert-warn .mono')).trim();
  await page.fill('input[name=code]', code);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(BASE + '/');
}

async function crawl(page, role, paths) {
  const problems = [];
  for (const p of paths) {
    const res = await page.goto(BASE + p);
    const status = res.status();
    const title = await page.title();
    if (status >= 500 || /Something went wrong/.test(await page.content())) problems.push(`${role} ${p}: HTTP ${status} ${title}`);
    else if (status >= 400) problems.push(`${role} ${p}: HTTP ${status} (${title})`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${role}-${p.replace(/[/?=&]+/g, '_') || 'home'}.png`, fullPage: true });
  }
  return problems;
}

(async () => {
  const browser = await chromium.launch();
  const all = [];
  const loanLinks = async (page) => page.$$eval('a[href^="/loans/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')).filter((h) => /^\/loans\/\d+$/.test(h)))]);
  for (const [role, extra] of Object.entries({
    officer: ['/customers/new', '/loans/redeem?ticket=1009', '/payments/unmatched', '/tasks'],
    cro: ['/archive', '/archive/expiring', '/archive/deleted', '/aml', '/admin/audit', '/admin/watchlists'],
    admin: ['/admin/users', '/admin/branches', '/admin/settings', '/admin/lists', '/admin/system', '/admin/sms', '/admin/audit', '/archive', '/archive/expiring', '/sales', '/payments/reversals', '/aml'],
  })) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => all.push(`${role} JS error: ${e.message}`));
    await login(page, role);
    const base = ['/', '/customers', '/loans', '/items', '/payments/refunds', '/stock', '/stock/access', '/reports', '/notifications', '/sales', '/account/password'];
    const reports = ['daily', 'portfolio', 'maturity', 'stock', 'forfeitures', 'customer?customer_id=1', 'expiry'].concat(role === 'officer' ? [] : ['risk', 'aml']).map((r) => '/reports/' + r);
    all.push(...await crawl(page, role, [...base, ...extra, ...reports]));
    await page.goto(BASE + '/loans');
    const ls = await loanLinks(page);
    all.push(...await crawl(page, role, ls));
    await page.goto(BASE + '/customers');
    const cs = await page.$$eval('a[href^="/customers/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')).filter((h) => /^\/customers\/\d+$/.test(h)))]);
    all.push(...await crawl(page, role, cs.slice(0, 12)));
    await page.goto(BASE + '/items?status=all');
    const is = await page.$$eval('a[href^="/items/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')).filter((h) => /^\/items\/\d+$/.test(h)))]);
    all.push(...await crawl(page, role, is));
    // print views on each loan
    for (const l of ls) all.push(...(await crawl(page, role, [l + '/ticket'])).filter((x) => !/403/.test(x)));
    if (role === 'admin' || role === 'cro') {
      await page.goto(BASE + '/archive');
      const as = await page.$$eval('a[href^="/archive/loan/"]', (x) => [...new Set(x.map((a) => a.getAttribute('href')).filter((h) => /^\/archive\/loan\/\d+$/.test(h)))]);
      all.push(...await crawl(page, role, as));
    }
    for (const fmt of ['xlsx', 'pdf']) {
      const r = await page.request.get(`${BASE}/reports/portfolio?format=${fmt}`);
      if (r.status() !== 200) all.push(`${role} export ${fmt}: HTTP ${r.status()}`);
    }
    console.log(`${role}: crawled ${base.length + extra.length + reports.length + ls.length * 2 + cs.length + is.length} pages`);
    await ctx.close();
  }
  await browser.close();
  if (all.length) { console.error('PROBLEMS:\n' + all.join('\n')); process.exit(1); }
  console.log('All pages rendered without server errors.');
})();
