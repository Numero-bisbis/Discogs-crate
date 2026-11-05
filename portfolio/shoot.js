// Takes the portfolio screenshots of Crate with the real collection, covers and previews.
// Runs in GitHub Actions (see .github/workflows/portfolio-shots.yml) against site/ served on localhost:8765.
// MOCK=/path/to/lib.js swaps in stand-in covers and audio for a dry run without network.
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.env.OUT || 'portfolio/shots';
fs.mkdirSync(OUT, { recursive: true });
const MOCK = process.env.MOCK ? require(process.env.MOCK) : null;
const URL0 = 'http://localhost:8765/';
const wait = (p, ms) => p.waitForTimeout(ms);
const settle = async (p, ms = 1500) => { await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); await wait(p, ms); };
const log = (...a) => console.log('[shots]', ...a);

async function ctx(b, opts, init) {
  const c = await b.newContext({ colorScheme: 'dark', ...opts });
  if (init) await c.addInitScript(init);
  if (MOCK) await MOCK.routes(c);
  return c;
}
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const LAND = { ...PHONE, viewport: { width: 844, height: 390 } };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const seed = () => { try {
  localStorage.setItem('crate.tf', JSON.stringify({ sort: 'bpm', dir: 1, genre: 'Electronic', style: 'House', bpmMin: 120 }));
  localStorage.setItem('crate.gen', JSON.stringify({ genre: 'Electronic', style: 'House', from: 118, to: 126, cam: '', n: 8 }));
} catch {} };

async function step(name, fn) { try { await fn(); log('ok', name); } catch (e) { log('FAILED', name, e.message.split('\n')[0]); } }

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let state = null;

  // ---- phone, portrait ----
  {
    const c = await ctx(b, PHONE, seed); const p = await c.newPage(); p.on('pageerror', (e) => log('pageerror', e.message));
    await p.goto(URL0); await settle(p, 2500);
    await step('phone-records', async () => { await p.screenshot({ path: `${OUT}/phone-records.png` }); });
    await step('phone-record', async () => {
      await p.locator('#record-grid > *').nth(3).click(); await settle(p, 1500);
      await p.screenshot({ path: `${OUT}/phone-record.png` });
      await p.locator('#drawer .close').click(); await wait(p, 800);
    });
    await step('phone-tracks', async () => { await p.click('nav.tabs button[data-view=tracks]'); await settle(p, 1500); await p.screenshot({ path: `${OUT}/phone-tracks.png` }); });
    await step('phone-generate', async () => {
      await p.click('nav.tabs button[data-view=generate]'); await wait(p, 800);
      await p.screenshot({ path: `${OUT}/phone-generate.png` });
      await p.locator('#generate button', { hasText: /^Generate$/ }).click(); await settle(p, 1500);
      await p.locator('#generate button', { hasText: 'Save to My mixes' }).click(); await wait(p, 1000);
    });
    await step('phone-mix', async () => {
      await p.click('nav.tabs button[data-view=mixes]'); await wait(p, 800);
      await p.locator('#mixes li').first().click(); await settle(p, 1500);
      await p.screenshot({ path: `${OUT}/phone-mix.png` });
    });
    state = await c.storageState();
    await step('phone-blend', async () => {
      await p.locator('#mix-main button', { hasText: 'Blend the previews' }).first().click(); await wait(p, 14000);
      await p.screenshot({ path: `${OUT}/phone-blend.png` });
      log('player says:', await p.locator('#player').innerText().catch(() => ''));
    });
    await step('phone-settings', async () => {
      await p.click('nav.tabs button[data-view=settings]'); await wait(p, 1000);
      await p.screenshot({ path: `${OUT}/phone-settings.png`, fullPage: true });
    });
    await c.close();
  }

  // ---- phone, sideways: Crate mode ----
  await step('crate', async () => {
    const c = await ctx(b, { ...LAND, storageState: state }, () => { try {
      localStorage.setItem('crate.rf', JSON.stringify({ sort: 'added', genre: 'Electronic' })); localStorage.setItem('crate.sideMode', JSON.stringify('crate'));
    } catch {} });
    const p = await c.newPage();
    await p.goto(URL0); await settle(p, 3000);
    if (await p.locator('#crate').isHidden()) await p.evaluate(() => document.querySelector('.vswitch button[data-mode=crate]')?.click());
    await settle(p, 1500);
    for (let k = 0; k < 3; k++) { await p.mouse.move(600, 180); await p.mouse.down(); await p.mouse.move(420, 180, { steps: 6 }); await p.mouse.up(); await wait(p, 1500); }
    await settle(p, 2000);
    await p.screenshot({ path: `${OUT}/crate-mode.png` });
    await p.mouse.click(422, 180); await settle(p, 2000);
    await p.screenshot({ path: `${OUT}/crate-flip.png` });
    await c.close();
  });

  // ---- phone, sideways: Decks ----
  await step('decks', async () => {
    const c = await ctx(b, { ...LAND, storageState: state }, () => { try { localStorage.setItem('crate.sideMode', JSON.stringify('list')); } catch {} });
    const p = await c.newPage();
    await p.goto(URL0); await settle(p, 1500);
    await p.evaluate(() => document.querySelector('.cf-close')?.click()); await wait(p, 400);
    await p.evaluate(() => document.querySelector('nav.tabs button[data-view=mixes]').click()); await wait(p, 1000);
    await p.locator('#mixes li').first().click().catch(() => {}); await wait(p, 600);
    await p.locator('#mix-main button:visible', { hasText: 'Decks' }).first().click(); await wait(p, 1000);
    for (const i of [0, 1]) {
      await p.locator('.dk-load').nth(i).click(); await settle(p, 1200);
      if (i === 0) await p.screenshot({ path: `${OUT}/decks-picker.png` });
      await p.locator('.sh-list li button').nth(i).click(); await wait(p, 5000);
      if (await p.locator('.dk-sheet:visible').count()) await p.locator('.sh-close').click();
      await wait(p, 500);
    }
    await p.locator('.dk-play').nth(0).click(); await wait(p, 400);
    await p.locator('.dk-sync').nth(1).click(); await p.locator('.dk-play').nth(1).click();
    await p.evaluate(() => { const x = document.querySelector('.mx-x input'); x.value = 40; x.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(p, 4000);
    await p.screenshot({ path: `${OUT}/decks.png` });
    log('decks say:', await p.locator('.dk-name').allInnerTexts());
    await c.close();
  });

  // ---- desktop ----
  await step('desktop', async () => {
    const c = await ctx(b, { ...DESK, storageState: state }); const p = await c.newPage();
    await p.goto(URL0); await settle(p, 3000);
    await p.screenshot({ path: `${OUT}/desktop-records.png` });
    await p.click('nav.tabs button[data-view=tracks]'); await settle(p, 2500);
    await p.screenshot({ path: `${OUT}/desktop-tracks.png` });
    await p.click('nav.tabs button[data-view=mixes]'); await wait(p, 800);
    await p.locator('#mixes li').first().click(); await settle(p, 1500);
    await p.screenshot({ path: `${OUT}/desktop-mix.png` });
    await p.locator('#mixes li').first().click();
    await p.click('nav.tabs button[data-view=records]'); await wait(p, 600);
    await p.locator('#record-grid > *').nth(3).click(); await settle(p, 1500);
    await p.screenshot({ path: `${OUT}/desktop-record.png` });
    await c.close();
  });
  await b.close();
})();
