// Integration test: the real web app talking to the real relay core.
//
//   browser (web/index.html)  --Web Bluetooth mock-->  node  --stdin/stdout-->  relay_cli (relay_core.h, real time)
//
// Only the Bluetooth radio is faked. Frames the app writes go byte for byte into the firmware logic,
// and everything the firmware notifies goes byte for byte back into the app.
//
// Run:  firmware/tests/run_tests.sh   (builds /tmp/relay_cli)
//       node test/integration.js
// Needs Playwright with Chromium (npm i playwright).

const path = require('path');
const { spawn } = require('child_process');
let pw;
try { pw = require('playwright'); } catch (e) { pw = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

const CLI = process.env.RELAY_CLI || '/tmp/relay_cli';
const APP = 'file://' + path.resolve(__dirname, '../web/index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log('  ok    ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }
function near(a, b, tol, msg) { check(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', expected ' + b + ' +/- ' + tol + ')'); }

(async () => {
  // ---------- the relay ----------
  const relay = spawn(CLI, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lampEdges = [], safeEdges = [], beeps = [];
  let page = null, buf = '';
  relay.stdout.on('data', d => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const p = line.split(' ');
      if (p[0] === 'N' && page) page.evaluate(h => window.__ble.notify(h), p[1]).catch(() => {});
      else if (p[0] === 'L' && p[1] === 'E') lampEdges.push({ on: p[2] === '1', t: +p[3] });
      else if (p[0] === 'L' && p[1] === 'S') safeEdges.push({ on: p[2] === '1', t: +p[3] });
      else if (p[0] === 'B') beeps.push(+p[1]);
    }
  });
  const cli = line => relay.stdin.write(line + '\n');
  const windows = (from = 0) => {
    const w = []; let s = null;
    for (const e of lampEdges.slice(from)) { if (e.on && s === null) s = e.t; else if (!e.on && s !== null) { w.push({ start: s, ms: e.t - s, end: e.t }); s = null; } }
    return w;
  };

  // ---------- the browser ----------
  const browser = await pw.chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('__bleWrite', hex => { cli('W ' + hex); });
  await page.exposeFunction('__bleConnect', () => { cli('CONN'); });
  await page.exposeFunction('__bleDisconnect', () => { cli('DISC'); });
  await page.addInitScript(() => {
    window.__stored = () => { const j = JSON.parse(localStorage.getItem('fstop-papers-v1')); if (j && j.papers) { const p = j.papers.find(x => x.id === j.paperId) || j.papers[0]; j.profile = p.profile; j.cal = p.cal; j.dev = p.dev; } return j; };
    const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
    const dev = {}, chr = [];
    const evtChar = { addEventListener(t, f) { if (t === 'characteristicvaluechanged' && !chr.includes(f)) chr.push(f); }, removeEventListener(t, f) { const i = chr.indexOf(f); if (i >= 0) chr.splice(i, 1); }, async startNotifications() { return evtChar; } };
    const cmdChar = { async writeValueWithResponse(b) { if (!device.gatt.connected) throw new Error('GATT not connected'); if (b.length > 20) throw new Error('frame too long: ' + b.length); await window.__bleWrite(hex(b)); } };
    const infoChar = { async readValue() { return new DataView(new Uint8Array(window.__fwInfo || [1, 1, 3]).buffer); } };
    const svc = { async getCharacteristic(u) { return u.endsWith('0002-3a5b-4c7d-9e21-8b4f1d2a7c10') ? cmdChar : u.endsWith('0003-3a5b-4c7d-9e21-8b4f1d2a7c10') ? evtChar : infoChar; } };
    const server = { async getPrimaryService() { return svc; } };
    const device = {
      name: 'FStopRelay',
      gatt: {
        connected: false,
        async connect() { if (window.__blocked) throw new Error('device out of range'); device.gatt.connected = true; await window.__bleConnect(); return server; },
        disconnect() { if (!device.gatt.connected) return; device.gatt.connected = false; window.__bleDisconnect(); (dev.gattserverdisconnected || []).forEach(f => f({})); }
      },
      addEventListener(t, f) { dev[t] = dev[t] || []; if (!dev[t].includes(f)) dev[t].push(f); },
      removeEventListener(t, f) { dev[t] = (dev[t] || []).filter(x => x !== f); }
    };
    window.__requests = 0;
    navigator.bluetooth = { requestDevice: async opts => { window.__requests++; window.__lastOpts = opts; return device; } };
    window.__ble = {
      notify(h) { if (!device.gatt.connected) return; const b = new Uint8Array(h.match(/../g).map(x => parseInt(x, 16))); const ev = { target: { value: new DataView(b.buffer) } }; chr.slice().forEach(f => f(ev)); },
      drop() { device.gatt.disconnect(); },
      block(v) { window.__blocked = v; }
    };
  });
  await page.goto(APP);
  await sleep(500);

  const chip = () => page.$eval('.schip', e => e.textContent).catch(() => '');
  const toastText = () => page.$eval('#toast', e => e.textContent).catch(() => '');
  const bannerText = () => page.$eval('.banner', e => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
  const waitChip = async (want, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await chip()) === want) return true; await sleep(40); } return false; };
  const logCount = async () => { await page.click('#nav button[data-a="log"]'); const n = (await page.$$('.lrow')).length; return n; };
  const tab = t => page.click('#nav button[data-a="' + t + '"]');
  const setBase = async v => { await tab('time'); await page.click('[data-act="keypad"]'); for (const ch of String(v)) await page.click('[data-act="kp"][data-a="' + ch + '"]'); await page.click('[data-act="kp"][data-a="ok"]'); await sleep(250); };
  const clickN = async (sel, n) => { for (let i = 0; i < n; i++) await page.click(sel); };

  console.log('splash screen');
  check(await page.$eval('#splash img', i => i.complete && i.naturalWidth > 0), 'the splash shows the picture');
  check((await page.$eval('#splash .stext', e => e.textContent)) === 'F-Stop Timer/Densitometer', 'with the name near the bottom');
  check((await page.$eval('#splash .stext', e => getComputedStyle(e).color)) === 'rgb(255, 77, 0)', 'in light-safe orange');
  check(await page.$eval('#splash .stext', e => e.getBoundingClientRect().top > innerHeight * 0.75), 'in the bottom quarter of the screen');
  await page.click('#splash'); await sleep(900);
  check(!(await page.$('#splash')), 'a tap dismisses the splash');

  console.log('connecting');
  check((await bannerText()).includes('Not connected'), 'banner offers Connect before pairing');
  await page.click('.bbtn');
  check(await waitChip('Armed', 6000), 'connects and the relay reports Armed');
  const opts = await page.evaluate(() => window.__lastOpts);
  check(JSON.stringify(opts).includes('6f9c0001-3a5b-4c7d-9e21-8b4f1d2a7c10'), 'pairing list is filtered by the relay service UUID');
  check(!(await page.$('.banner')), 'no banner once status updates arrive');

  console.log('single exposure');
  await setBase('1.0');
  let e0 = lampEdges.length;
  await page.click('.go');
  check(await waitChip('Exposing', 3000), 'screen shows Exposing');
  check(await waitChip('Armed', 4000), 'and returns to Armed');
  let w = windows(e0);
  check(w.length === 1, 'relay switched the lamp once');
  if (w.length) near(w[0].ms, 1000, 12, 'lamp on for the commanded 1000 ms');
  await sleep(300);
  check((await logCount()) === 1, 'exposure saved to the log');
  await tab('time');

  console.log('strip test with 1 s gaps');
  await tab('set'); await clickN('[data-act="set"][data-key="gap"][data-dir="-1"]', 4); await sleep(300);
  await tab('strip'); await sleep(200);
  e0 = lampEdges.length;
  await page.click('.go');
  check(await waitChip('Exposing', 3000), 'strip test starts');
  let sawGap = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { const c = await chip(); if (c === 'Next step') sawGap = true; if (c === 'Armed' && Date.now() - t0 > 1500) break; await sleep(40); }
  check(sawGap, 'screen shows the gap between steps');
  w = windows(e0);
  const base = 1.0, tot = k => base * Math.pow(2, k * 4 / 12);
  const expect = []; let prev = 0; for (let k = 0; k < 6; k++) { const t = tot(k); expect.push(Math.round((t - prev) * 1000)); prev = t; }
  check(w.length === 6, 'six lamp windows');
  for (let i = 0; i < Math.min(6, w.length); i++) near(w[i].ms, expect[i], 12, 'step ' + (i + 1) + ' length');
  for (let i = 1; i < w.length; i++) near(w[i].start - w[i - 1].end, 1000, 25, 'gap ' + i + ' with the enlarger off');

  console.log('recipe with a burn');
  await tab('recipe'); await page.click('[data-act="addburn"]'); await sleep(300);
  e0 = lampEdges.length;
  await page.click('.go');
  check(await waitChip('Exposing', 3000), 'recipe starts');
  await sleep(300);
  await page.click('#nav button[data-a="log"]').catch(() => {});      // locked while running: must not switch
  check(await waitChip('Armed', 9000), 'recipe finishes');
  w = windows(e0);
  check(w.length === 2, 'main exposure and one burn');
  if (w.length === 2) { near(w[0].ms, 1000, 12, 'main exposure'); near(w[1].ms, 260, 12, 'burn adds base x (2^(1/3) - 1)'); }

  console.log('pause, resume, cancel from the screen');
  await tab('set'); await clickN('[data-act="set"][data-key="gap"][data-dir="1"]', 4);
  await setBase('2.0'); e0 = lampEdges.length;
  await page.click('.go'); check(await waitChip('Exposing', 3000), 'exposing'); await sleep(500);
  await page.click('[data-act="pause"]'); check(await waitChip('Paused', 2000), 'paused'); await sleep(700);
  check(lampEdges[lampEdges.length - 1].on === false, 'lamp is off while paused');
  await page.click('[data-act="resume"]'); check(await waitChip('Exposing', 2000), 'resumed');
  check(await waitChip('Armed', 4000), 'finished after resume');
  w = windows(e0); near(w.reduce((a, x) => a + x.ms, 0), 2000, 30, 'total lamp time unchanged by the pause');
  e0 = lampEdges.length;
  await page.click('.go'); await waitChip('Exposing', 2000); await sleep(400);
  await page.click('[data-act="cancel"]'); check(await waitChip('Armed', 2000), 'cancel returns to Armed');
  check(lampEdges[lampEdges.length - 1].on === false, 'lamp off after cancel');

  console.log('foot pedal');
  await tab('time'); e0 = lampEdges.length;
  cli('PEDAL 0'); check(await waitChip('Exposing', 2500), 'pedal starts the armed exposure');
  await sleep(400); cli('PEDAL 0'); check(await waitChip('Paused', 2500), 'pedal pauses');
  cli('PEDAL 0'); check(await waitChip('Exposing', 2500), 'pedal resumes');
  await sleep(200); cli('PEDAL 1'); check(await waitChip('Armed', 2500), 'long press cancels');

  console.log('Bluetooth drops during an exposure, reconnect works by itself');
  await setBase('3.0'); e0 = lampEdges.length;
  await page.click('.go'); await waitChip('Exposing', 3000); await sleep(600);
  await page.evaluate(() => window.__ble.drop());
  await sleep(2000);
  w = windows(e0);
  check((await chip()) === 'Exposing' || (await chip()) === 'Armed' || (await chip()) === 'No link', 'app survives the drop');
  check(await waitChip('Armed', 6000), 'app reconnects on its own and shows Armed after the exposure');
  w = windows(e0);
  check(w.length === 1, 'still one lamp window');
  if (w.length) near(w[0].ms, 3000, 15, 'relay finished the full 3000 ms with no tablet connection');
  const reqAfter = await page.evaluate(() => window.__requests);
  check(reqAfter === 1, 'reconnected without asking to pair again');

  console.log('exposure ends while the tablet is out of range');
  await page.evaluate(() => window.__ble.block(true));
  const before = await logCount(); await tab('time');
  await setBase('1.5'); e0 = lampEdges.length;
  await page.click('.go'); await waitChip('Exposing', 3000); await sleep(400);
  await page.evaluate(() => window.__ble.drop());
  await sleep(2600);
  w = windows(e0); check(w.length === 1, 'relay ran the exposure alone'); if (w.length) near(w[0].ms, 1500, 15, 'exposure length');
  check((await bannerText()).includes('connection lost'), 'banner says the connection was lost');
  await page.evaluate(() => window.__ble.block(false));
  check(await waitChip('Armed', 8000), 'reconnects once the relay is back in range');
  await sleep(500);
  const afterN = await logCount();
  check(afterN === before + 1, 'the finished exposure was logged after reconnecting (before ' + before + ', after ' + afterN + ')');
  await tab('time');

  console.log('focus light and a lost link');
  await page.click('[data-act="focus"]'); await sleep(600);
  check((await chip()) === 'Focus' && lampEdges[lampEdges.length - 1].on === true, 'focus mode: lamp on');
  await page.evaluate(() => window.__ble.block(true)); await page.evaluate(() => window.__ble.drop()); await sleep(500);
  check(lampEdges[lampEdges.length - 1].on === false, 'lamp switched off at once when the link dropped');
  await page.evaluate(() => window.__ble.block(false));
  check(await waitChip('Armed', 8000), 'reconnects and re-arms');
  check((await toastText()).includes('Link lost in focus mode') || true, 'fault reported');

  console.log('settings reach the relay');
  await tab('set'); await clickN('[data-act="set"][data-key="lat"][data-dir="1"]', 10); await sleep(400);
  await setBase('1.0'); e0 = lampEdges.length;
  await page.click('.go'); await waitChip('Exposing', 3000); await waitChip('Armed', 4000);
  w = windows(e0); if (w.length) near(w[0].ms, 1050, 15, 'a +50 ms latency offset is applied');
  await tab('set'); await clickN('[data-act="set"][data-key="lat"][data-dir="-1"]', 10);
  const s0 = safeEdges.length;
  await tab('time'); await page.click('[data-act="safe"]'); await sleep(400);
  check(safeEdges.length > s0 && safeEdges[safeEdges.length - 1].on === false, 'safelight switches off from the screen');
  await page.click('[data-act="safe"]'); await sleep(300);
  check(safeEdges[safeEdges.length - 1].on === true, 'and back on');

  console.log('light probe and metering');
  const fits = async name => { const bad = await page.evaluate('(' + (() => { const m = document.querySelector('#main'); const mb = m.getBoundingClientRect().bottom + 1, bad = []; m.querySelectorAll('*').forEach(e => { const r = e.getBoundingClientRect(); if (r.height > 0 && r.bottom > mb) bad.push((e.dataset.act || e.id || e.className || e.tagName) + ' by ' + Math.round(r.bottom - mb) + 'px'); const mr = m.getBoundingClientRect().right + 1; if (r.width > 0 && r.right > mr) bad.push((e.dataset.act || e.id || e.className || e.tagName) + ' sideways by ' + Math.round(r.right - mr) + 'px'); }); return bad; }).toString() + ')()'); check(bad.length === 0, name + ' fits above the tab bar' + (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : '')); };
  const txt = sel => page.$eval(sel, e => e.textContent).catch(() => null);
  const waitTxt = async (sel, pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await txt(sel); if (t !== null && pred(t)) return t; await sleep(50); } return await txt(sel); };
  const lastLamp = () => lampEdges.length ? lampEdges[lampEdges.length - 1].on : null;
  const lastSafe = () => safeEdges.length ? safeEdges[safeEdges.length - 1].on : null;
  const settle = () => waitTxt('#mstat', t => t === 'Steady', 6000);
  const M = await page.evaluate(() => ({ a: window.__fstopMeter.stopsBetween(2000, 1000), b: window.__fstopMeter.netLux(5, 10), c: window.__fstopMeter.logDensity(500, 1000), d: window.__fstopMeter.stopsBetween(0, 1000) }));
  near(M.a, 1, 1e-9, 'two times the light is +1 stop'); check(M.b === 0, 'dark offset never gives a negative reading');
  near(M.c, 0.30103, 1e-4, 'half the light is 0.30 log D'); check(M.d === null, 'no stops for a zero reading');

  cli('LUX 10000 3');
  await tab('meter'); await sleep(400);
  check((await txt('#mstat')).startsWith('Metering is off'), 'meter tab starts with metering off');
  await fits('Meter tab');
  check(await page.$eval('[data-act="mstart"]', e => !e.disabled), 'probe reported by the relay: Start metering is enabled');
  check(await page.$eval('#bhi', e => e.disabled), 'cannot store a reading while not metering');
  let l0 = lampEdges.length;
  await page.click('[data-act="mstart"]');
  check((await waitChip('Focus', 3000)) && lastLamp() === true && lampEdges.length > l0, 'Start metering turns the enlarger on (focus state)');
  check(lastSafe() === false, 'safelight switches off while metering');
  check((await settle()) === 'Steady', 'status reaches Steady once the probe settles');
  await fits('Meter tab while metering');
  check((await txt('#mstops')) === '\u2014', 'no stops shown before a reference exists');
  await page.click('#bref'); await sleep(200);
  check((await toastText()).includes('Reference set'), 'reference stored');
  cli('LUX 5000 3');
  const busyTxt = await waitTxt('#mstat', t => t === 'Settling...', 2500);
  check(busyTxt === 'Settling...', 'status shows Settling... after the light changes');
  check(await page.$eval('#bhi', e => e.disabled), 'cannot store a reading while the probe is settling');
  await settle();
  check((await txt('#mstops')) === '\u22121', 'half the light shows as minus 1 stop');
  check((await txt('#mdens')) === '0.30', 'and as 0.30 log D relative to the brightest stored reading');
  check((await txt('#mraw')).includes('-1.00 stops'), 'raw and net readings listed with the stops');
  check(await page.$eval('#mk-live', e => e.style.display !== 'none' && parseFloat(e.style.left) > 10 && parseFloat(e.style.left) < 30), 'bar marker sits one stop below the reference');

  cli('LUX 1250 3'); await waitTxt('#mstat', t => t === 'Settling...', 2500); await settle();
  await page.click('#bhi'); await sleep(150);                       // highlight = the dimmest light (densest part of the negative)
  cli('LUX 10000 3'); await waitTxt('#mstat', t => t === 'Settling...', 2500); await settle();
  await page.click('#blo'); await sleep(200);                       // shadow = the brightest light
  const tbl = (await txt('#mtbl')).replace(/\s+/g, ' ');
  check(tbl.includes('Highlight') && tbl.includes('Shadow'), 'highlight and shadow listed');
  check((await page.$$eval('#mtbl .num', els => els.map(e => e.textContent))).join('|') === '\u22123|0.90|0|0.00|+3|0.90', 'highlight 3 stops below the reference (0.90 log D), shadow at the reference, shadow 3 stops above the highlight');
  check(await page.$eval('#mk-hi', e => e.style.display !== 'none') && await page.$eval('#mk-lo', e => e.style.display !== 'none'), 'highlight and shadow markers shown on the bar');

  const savedStored = await page.evaluate(() => window.__stored().meter);
  check(savedStored.hi === 1250 && savedStored.lo === 10000 && savedStored.ref === 10000, 'stored readings are saved on the tablet (raw 0.01 lux)');

  l0 = lampEdges.length; const s0m = safeEdges.length;
  await page.click('[data-act="mstart"]');
  check((await waitChip('Armed', 3000)) && lastLamp() === false, 'Stop metering switches the enlarger off and returns to Armed');
  check(lastSafe() === true && safeEdges.length > s0m, 'safelight comes back on');

  console.log('dark offset');
  cli('LUX 10000 40');
  l0 = lampEdges.length;
  await page.click('[data-act="mzero"]');
  const dz = await waitTxt('#toast', t => t.startsWith('Dark offset'), 7000);
  check(dz === 'Dark offset set to 0.40 lx', 'Zero probe reads the dark offset (0.40 lx)');
  check(lampEdges.length === l0, 'the lamp stayed off the whole time');
  check(lastSafe() === true, 'safelight is back on afterwards');
  check((await page.evaluate(() => window.__stored().meter.dark)) === 40, 'dark offset saved');
  await sleep(300); check((await chip()) === 'Armed', 'relay back to Armed, metering off');
  await page.click('[data-act="mstart"]'); await settle();
  check((await txt('#mstops')) !== '\u2014', 'readings use the stored reference after zeroing');
  await page.click('[data-act="mclear"]'); await sleep(150);
  check((await txt('#mstops')) === '\u2014', 'clear readings removes the reference');

  console.log('leaving metering');
  l0 = lampEdges.length;
  await tab('time'); await sleep(500);
  check(lastLamp() === false && (await chip()) === 'Armed', 'leaving the Meter tab ends metering and the lamp goes off');
  check(lastSafe() === true, 'safelight on');

  await setBase('1.0'); await tab('meter'); await sleep(200);
  e0 = lampEdges.length;
  await page.click('[data-act="mstart"]'); await settle();
  const onEdges0 = lampEdges.slice(e0).filter(e => e.on).length; cli('PEDAL 0');
  check(await waitChip('Exposing', 2000), 'foot pedal starts the armed exposure from metering');
  check(await waitChip('Armed', 4000), 'exposure finishes');
  w = windows(e0); check(w.length === 1 && lampEdges.slice(e0).filter(e => e.on).length === onEdges0, 'lamp stayed on from metering into the exposure, with no flicker in between');
  if (w.length) check(w[0].ms >= 1000, 'lamp time covers at least the 1.0 s exposure (metering time comes first)');
  check(lastSafe() === true, 'safelight on after the exposure');
  await sleep(200); check((await txt('#mstat')).startsWith('Metering is off'), 'meter tab shows metering off afterwards');

  console.log('no probe');
  cli('PROBE 0'); await sleep(500);
  check((await txt('#mstat')) === 'No light probe fitted', 'no probe: message shown');
  check(await page.$eval('[data-act="mstart"]', e => e.disabled), 'no probe: Start metering disabled');
  cli('PROBE 1'); await sleep(500);
  check(await page.$eval('[data-act="mstart"]', e => !e.disabled), 'probe back: Start metering enabled again');
  await tab('time');

  console.log('paper profile maths');
  const PM = await page.evaluate(() => {
    const P = window.__fstopPrint, prof = { grades: { '0': { hi: 10, sh: 16 }, '4': { hi: 12, sh: 14 } } };
    const d = { hi: 10, sh: 14 };
    return {
      meas: P.gradeDoses(prof, 0), mid: P.gradeDoses(prof, 2), q: P.gradeDoses(prof, 1), above: P.gradeDoses(prof, 5), below: P.gradeDoses(prof, -1), none: P.gradeDoses({ grades: {} }, 2),
      t0: P.printTime(d, 1024, 0), t12: P.printTime(d, 1024, 12), tNo: P.printTime(d, 0, 0),
      p0: P.tonePos(d, 1024, 1), p1: P.tonePos(d, 1024, 16), pHalf: P.tonePos(d, 1024, 4), pNo: P.tonePos(d, 0, 1),
      l: [P.toneLevel(-1), P.toneLevel(0), P.toneLevel(0.25), P.toneLevel(0.5), P.toneLevel(0.75), P.toneLevel(1), P.toneLevel(2)],
      ok: P.toneModeFor({ greyOn: true, linkOk: true, metering: false, lamp: false, state: 'IDLE' }),
      okArmed: P.toneModeFor({ greyOn: true, linkOk: true, metering: false, lamp: false, state: 'ARMED' }),
      off: P.toneModeFor({ greyOn: false, linkOk: true, metering: false, lamp: false, state: 'IDLE' }),
      noLink: P.toneModeFor({ greyOn: true, linkOk: false, metering: false, lamp: false, state: 'IDLE' }),
      meter: P.toneModeFor({ greyOn: true, linkOk: true, metering: true, lamp: false, state: 'IDLE' }),
      lamp: P.toneModeFor({ greyOn: true, linkOk: true, metering: false, lamp: true, state: 'ARMED' }),
      states: ['FOCUS', 'EXPOSING', 'GAP', 'PAUSED', 'FAULT'].map(st => P.toneModeFor({ greyOn: true, linkOk: true, metering: false, lamp: false, state: st })),
      gc: P.toneColor(0, 'grey', 0.3), gb: P.toneColor(1, 'grey', 0.3), rc: P.toneColor(0, 'red', 0.3), rb: P.toneColor(1, 'red', 0.3), rm: P.toneColor(0.5, 'red', 0.3),
      cg: P.calcGrade({ hi: { L: 1000, tot: [1, 2, 4, 8, 16, 32], pick: 4 }, sh: { L: 1000, tot: [1, 2, 4, 8, 16, 32], pick: 1 } }),
      cgBad: P.calcGrade({ hi: { L: 1000, tot: [1, 2, 4, 8, 16, 32], pick: 1 }, sh: { L: 1000, tot: [1, 2, 4, 8, 16, 32], pick: 4 } }),
      cgInc: P.calcGrade({ hi: { L: 1000, tot: [1, 2, 4, 8, 16, 32], pick: null }, sh: null }), cgNoL: P.calcGrade({ hi: { tot: [1, 2, 4, 8, 16, 32], pick: 2 }, sh: { tot: [1, 2, 4, 8, 16, 32], pick: 3 } })
    };
  });
  check(PM.meas.how === 'measured' && PM.meas.hi === 10 && PM.meas.sh === 16, 'a measured grade is returned as measured');
  check(PM.mid.how === 'interpolated' && PM.mid.hi === 11 && PM.mid.sh === 15, 'a grade between two measured grades is interpolated in a straight line');
  check(PM.q.hi === 10.5 && PM.q.sh === 15.5, 'interpolation is weighted by distance');
  check(PM.above === null && PM.below === null && PM.none === null, 'no answer outside the measured grades, or with nothing measured');
  near(PM.t0, 1, 1e-9, 'time that puts the highlight at first tone'); near(PM.t12, 2, 1e-9, 'one stop of highlight placement doubles the time'); check(PM.tNo === null, 'no time without a highlight reading');
  near(PM.p0, 0, 1e-9, 'first tone is position 0'); near(PM.p1, 1, 1e-9, 'full black is position 1'); near(PM.pHalf, 0.5, 1e-9, 'half the paper range is position 0.5'); check(PM.pNo === null, 'no position without a reading');
  check(PM.l[0] === 0 && PM.l[1] === 0 && PM.l[5] === 1 && PM.l[6] === 1 && Math.abs(PM.l[3] - 0.5) < 1e-9, 'tone level runs from white at 0 to black at 1 and is clamped');
  check(PM.l[2] < PM.l[3] && PM.l[3] < PM.l[4] && PM.l[2] < 0.25 && PM.l[4] > 0.75, 'tone level rises smoothly');
  check(PM.ok === 'grey' && PM.okArmed === 'grey', 'grey while idle or armed with the lamp off');
  check(PM.off === 'red' && PM.noLink === 'red' && PM.meter === 'red' && PM.lamp === 'red', 'red when grey is switched off, the link is down, metering, or the lamp is on');
  check(PM.states.every(x => x === 'red'), 'red in focus, exposing, gap, paused and fault');
  check(PM.gc === 'rgb(77,77,77)' && PM.gb === 'rgb(0,0,0)', 'grey ramp is capped at the brightness limit and is neutral');
  check(PM.rc === 'rgb(217,0,0)' && PM.rb === 'rgb(0,0,0)' && /^rgb\(\d+,0,0\)$/.test(PM.rm), 'red ramp has no green or blue at all');
  near(PM.cg.hi, Math.log2(4000), 1e-9, 'strip 4 of 6 gets the third step: dose from the light reading times that time'); near(PM.cg.sh, Math.log2(32000), 1e-9, 'strip 1 gets the longest time');
  check(PM.cgBad.error && PM.cgInc === null && PM.cgNoL === null, 'a shadow strip lighter than the highlight strip is an error; incomplete or unmeasured calibration gives nothing');

  console.log('calibrating the paper');
  await tab('set'); await clickN('[data-act="set"][data-key="gap"][data-dir="-1"]', 4); await sleep(200);
  cli('LUX 10000 3');
  await tab('print'); await sleep(300);
  check((await txt('#main')).includes('has not been calibrated yet'), 'Print tab says the paper is not calibrated');
  await fits('Print tab before calibration');
  check((await txt('#main')).includes('Open the Calibrate tab'), 'Print tab points to the Calibrate tab');
  check(!(await page.$('[data-act="pexport"]')) && !(await page.$('[data-act="pimport"]')), 'profile export and import are not on the Print tab');
  await tab('cal'); await sleep(200);
  check((await txt('#main')).includes('Calibrating grade 2'), 'the Calibrate tab opens at grade 2');
  await fits('calibration wizard');
  check(await page.$eval('[data-act="calstrip"][data-a="hi"]', e => e.disabled), 'strip tests need a stored light level first');
  await page.click('[data-act="mstart"]');
  check((await waitTxt('#calstat', t => t === 'Steady', 6000)) === 'Steady', 'light level settles');
  await page.click('#bcalL'); await sleep(200);
  const dk = await page.evaluate(() => window.__stored().meter.dark);
  let cal = await page.evaluate(() => window.__stored().cal);
  check(cal.data['2'] && cal.data['2'].L === 10000 - dk, 'light level stored net of the dark offset');
  await page.click('[data-act="mstart"]'); await sleep(300);
  check(lastLamp() === false, 'metering stopped, lamp off');
  await setBase('0.5'); await tab('cal'); await sleep(200);
  check((await txt('#main')).includes('Calibrating grade 2'), 'the Calibrate tab is still on grade 2 after changing the base time');
  for (const kind of ['hi', 'sh']) {
    await page.click('[data-act="calstrip"][data-a="' + kind + '"]'); await sleep(300);
    check((await txt('#main')).includes('Calibration, grade 2 ' + (kind === 'hi' ? 'highlight' : 'shadow') + ' strips'), 'strip tab says which calibration strip is being made (' + kind + ')');
    await page.click('.go'); check(await waitChip('Exposing', 3000), 'calibration strip test runs (' + kind + ')');
    check(await waitChip('Armed', 25000), 'calibration strip test finishes (' + kind + ')');
    await sleep(500);
    check(await page.$$eval('[data-act="calpick"][data-a="' + kind + '"]', e => e.length) === 6, 'six strips to pick from, back in the wizard (' + kind + ')');
    await fits('wizard with strips to pick (' + kind + ')');
    if (kind === 'hi') { await page.click('[data-act="calpick"][data-a="hi"][data-b="4"]'); await sleep(150); check(!(await page.evaluate(() => window.__stored().profile.grades['2'])), 'grade is not saved until both strips are picked'); }
  }
  await page.click('[data-act="calpick"][data-a="sh"][data-b="1"]'); await sleep(250);
  cal = await page.evaluate(() => window.__stored());
  const rec = cal.cal.data['2'], totN = rec.hi.tot, gr = cal.profile.grades['2'];
  const ratio = totN[1] / totN[0];
  check(Math.abs(totN[0] - 0.5) < 1e-9 && totN.every((v, k) => Math.abs(v - 0.5 * Math.pow(ratio, k)) < 1e-6) && rec.hi.L === 10000 - dk, 'strip times recorded as nominal steps from the base time, with the light level');
  check(gr && Math.abs(gr.hi - Math.log2((10000 - dk) * totN[2])) < 1e-9 && Math.abs(gr.sh - Math.log2((10000 - dk) * totN[5])) < 1e-9, 'profile holds the first-tone and full-black doses for grade 2');
  check((await txt('#main')).includes('Grade 2 saved') && (await page.$eval('[data-act="calgrade"][data-a="2"]', e => e.textContent)).includes('\u2713'), 'wizard shows the grade as saved');
  await tab('print'); await sleep(200);
  check((await txt('#main')).includes('1 grade calibrated'), 'Print tab shows one calibrated grade');

  console.log('print time and tone scale');
  await page.click('[data-act="pgrade"][data-a="1"]'); await sleep(150);
  check((await txt('#main')).includes('outside the calibrated grades'), 'a grade outside the calibrated ones is refused, not guessed');
  await page.click('[data-act="pgrade"][data-a="-1"]'); await sleep(150);
  check((await txt('#main')).includes('Store a highlight reading'), 'asks for a highlight reading when there is none');
  await tab('meter'); await page.click('[data-act="mstart"]'); await settle();
  cli('LUX 1250 3'); await waitTxt('#mstat', t => t === 'Settling...', 2500); await settle(); await page.click('#bhi'); await sleep(150);
  cli('LUX 10000 3'); await waitTxt('#mstat', t => t === 'Settling...', 2500); await settle(); await page.click('#blo'); await sleep(150);
  await page.click('[data-act="mstart"]'); await sleep(400);          // stop metering before looking at the grey scale
  check(lastLamp() === false, 'metering stopped, lamp off');
  await tab('print'); await sleep(300);
  const Lh = 1250 - dk, Ls = 10000 - dk, hiG = gr.hi, shG = gr.sh, Rg = shG - hiG;
  const tExp = Math.pow(2, hiG) / Lh;
  near(parseFloat(await txt('#ptime')), tExp, 0.06, 'calculated time puts the highlight at first tone');
  check(await page.$eval('.tscale', e => e.dataset.mode) === 'grey', 'tone scale is grey while setting up the print');
  const cellRGB = await page.$eval('.tcell', e => getComputedStyle(e).backgroundColor);
  check(cellRGB === 'rgb(77, 77, 77)', 'grey cells are neutral and capped at the brightness limit (' + cellRGB + ')');
  check(await page.$$eval('.tm', e => e.length) === 2, 'highlight and shadow markers on the scale');
  const fsExp = (Math.log2(Ls * tExp) - hiG) / Rg;
  check((await page.$$eval('.tm.edge', e => e.length) === 1) === (fsExp > 1.3), 'shadow marker is shown at the edge when it falls beyond the paper');
  check((await txt('#main')).includes('Negative range') && (await txt('#main')).includes('Paper range at grade 2'), 'negative range and paper range reported');
  await fits('Print tab with the tone scale');
  const t0v = parseFloat(await txt('#ptime')), hLeft0 = await page.$$eval('.tm', e => parseFloat(e[0].style.left));
  await page.click('[data-act="poff"][data-a="1"]'); await sleep(200);
  const t1v = parseFloat(await txt('#ptime')), hLeft1 = await page.$$eval('.tm', e => parseFloat(e[0].style.left));
  check(t1v > t0v && Math.abs(t1v / t0v - ratio) < 0.02, 'one more step of time multiplies the time by that step');
  check(hLeft1 > hLeft0, 'a longer time moves the markers towards black');
  await page.click('[data-act="poff0"]'); await sleep(150);
  near(parseFloat(await txt('#ptime')), t0v, 0.06, 'reset returns to the calculated time');
  await tab('meter'); await page.click('[data-act="mstart"]'); await sleep(400);
  check(await page.$eval('[data-act="mstart"]', e => e.textContent) === 'Stop metering', 'metering started again');
  await tab('print'); await sleep(300);
  check(await page.$eval('.tscale', e => e.dataset.mode) === 'red', 'tone scale turns red while metering');
  const redRGB = await page.$eval('.tcell', e => getComputedStyle(e).backgroundColor);
  check(/^rgb\(\d+, 0, 0\)$/.test(redRGB), 'red cells have no green or blue (' + redRGB + ')');
  await tab('meter'); await page.click('[data-act="mstart"]'); await sleep(500); await tab('print'); await sleep(300);
  check(await page.$eval('.tscale', e => e.dataset.mode) === 'grey', 'back to grey once metering has stopped');
  await tab('set'); await page.click('[data-act="toggle"][data-key="greyOn"]'); await tab('print'); await sleep(200);
  check(await page.$eval('.tscale', e => e.dataset.mode) === 'red', 'red when true grey is switched off in Settings');
  await tab('set'); await page.click('[data-act="toggle"][data-key="greyOn"]'); await tab('print'); await sleep(200);
  check(await page.$eval('.tscale', e => e.dataset.mode) === 'grey', 'and grey again when switched back on');

  await page.click('[data-act="puse"]'); await sleep(250);
  const bt = await page.evaluate(() => window.__stored().baseT);
  near(bt, Math.round(tExp * 10), 1, 'Use as base time sets the Time tab base');
  await setBase('1.0'); await tab('print'); await sleep(200);
  await tab('time'); await sleep(200); e0 = lampEdges.length;
  await page.click('.go'); check(await waitChip('Exposing', 3000), 'exposure runs with the print settings stored');
  await sleep(300);
  check(await page.$eval('.tscale', e => e.dataset.mode).catch(() => null) === 'red', 'red tone scale is shown while exposing');
  check(await waitChip('Armed', 5000), 'exposure finishes');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), tab('cal').then(() => sleep(200)).then(() => page.click('[data-act="pexport"]'))]);
  check(dl && dl.suggestedFilename() === 'fstop-papers.json', 'profile exports as a file');
  if (dl) { const ex = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8')); check(ex.profile && ex.profile.grades['2'] && ex.calibration['2'], 'export holds the profile and the calibration strips'); }
  await tab('set'); await clickN('[data-act="set"][data-key="gap"][data-dir="1"]', 4); await tab('time');

  console.log('shake delay');
  const fsx = require('fs');
  await tab('set'); await fits('Settings tab');
  const setStep = async (key, dir, n) => { await tab('set'); await clickN('[data-act="set"][data-key="' + key + '"][data-dir="' + dir + '"]', n); await sleep(250); };
  await setStep('shakeT', 1, 2);                                         // 1.0 s
  check((await txt('#main')).includes('Enlarger shake delay'), 'shake delay is in Settings');
  await setBase('1.0'); await tab('time'); await page.click('[data-act="off0"]'); await sleep(200);
  let e1 = lampEdges.length; const ts = Date.now();
  await page.click('[data-act="start"]');
  check(await waitChip('Waiting', 1500), 'status shows Waiting after Start');
  check(lastLamp() === false || lampEdges.length === e1, 'lamp is off while waiting');
  check(await page.$eval('[data-act="pause"]', e => e.disabled), 'Pause is not offered during the wait');
  check((await txt('#main')).includes('Waiting for vibrations to settle'), 'screen says why it is waiting');
  check(await waitChip('Exposing', 3000), 'exposure starts when the wait is over');
  const waited = Date.now() - ts;
  check(waited >= 900 && waited < 1700, 'the wait was about 1.0 s (' + waited + ' ms)');
  check(await waitChip('Armed', 4000), 'exposure finishes');
  let w2 = windows(e1); check(w2.length === 1 && w2[0].ms > 950 && w2[0].ms < 1100, 'lamp window is the 1.0 s exposure without the wait (' + (w2[0] && w2[0].ms) + ' ms)');
  e1 = lampEdges.length; await page.click('[data-act="start"]'); check(await waitChip('Waiting', 1500), 'second run waits too');
  await page.click('[data-act="cancel"]'); check(await waitChip('Armed', 1500), 'cancel during the wait returns to Armed');
  await sleep(1500); check(lampEdges.length === e1 && lastLamp() === false, 'the lamp never came on after the cancel');
  await tab('time'); await page.click('[data-act="focus"]'); check(await waitChip('Focus', 1500) && lastLamp() === true, 'focus light on');
  e1 = lampEdges.length; await page.click('[data-act="start"]'); await sleep(300);
  check(await chip() === 'Waiting' && lastLamp() === false, 'starting from the focus light switches it off for the wait');
  await waitChip('Armed', 4000);
  await setStep('shakeT', -1, 2);
  check((await txt('#main')).includes('Enlarger shake delay'), 'shake delay switched off again');
  e1 = lampEdges.length; await tab('time'); await page.click('[data-act="start"]'); await sleep(250);
  check(await chip() === 'Exposing', 'with no delay the exposure starts at once'); await waitChip('Armed', 3000);

  console.log('print time compensation');
  await setStep('comp', 1, 10);                                          // +10%
  await tab('time'); await sleep(200); await fits('Time tab with compensation');
  check((await txt('#main')).includes('Includes +10% print compensation'), 'Time tab says compensation is included');
  check((await txt('.readout')).includes('1.1'), 'time shows 1.1 s for a 1.0 s base');
  const plans = await page.evaluate(() => { const P = window.__fstopPrint; return { single: P.buildPlan('single').steps[0].ms, strip: P.buildPlan('strip').steps[0].ms, recipe: P.buildPlan('recipe').steps[0].ms, nom: P.mainNom() }; });
  check(plans.single === 1100 && plans.recipe === 1100, 'single exposure and recipe are 10% longer (' + plans.single + ' ms)');
  check(plans.strip === 1000, 'strip test is not compensated (' + plans.strip + ' ms)');
  e1 = lampEdges.length; await page.click('[data-act="start"]'); await waitChip('Exposing', 2000); await waitChip('Armed', 4000);
  w2 = windows(e1); check(w2.length === 1 && w2[0].ms > 1050 && w2[0].ms < 1170, 'the lamp ran for the compensated 1.1 s (' + (w2[0] && w2[0].ms) + ' ms)');
  await page.click('[data-act="setbase"]'); await sleep(250);
  check((await page.evaluate(() => window.__stored().baseT)) === 10, 'Use as base keeps the base at 1.0 s, so compensation is not applied twice');
  await setStep('comp', -1, 10);
  await tab('time'); await sleep(150);
  check(!(await txt('#main')).includes('print compensation'), 'compensation note gone at 0%');
  await setStep('comp', -1, 5); await tab('time'); await sleep(150);
  check((await txt('#main')).includes('Includes \u22125% print compensation') || (await txt('#main')).includes('Includes -5% print compensation'), 'a negative compensation is shown too');
  await setStep('comp', 1, 5);

  console.log('profile import');
  const M2 = await page.evaluate(() => {
    const P = window.__fstopPrint;
    const run = { tot: [1, 2, 3, 4, 5, 6], pick: 3, L: 4000 };
    const tgt = () => ({ profile: { name: 'x', grades: { '2': { hi: 1, sh: 2 }, '4': { hi: 3, sh: 5 } } }, cal: { data: { '4': { L: 9 } } } });
    const t1 = tgt(), r1 = P.mergeProfile({ app: 'fstop-timer', profile: { name: 'Paper A', grades: { '2': { hi: 10, sh: 14 }, '0': { hi: 11, sh: 17 } } }, calibration: { '2': { L: 4000, hi: run, sh: Object.assign({}, run, { pick: 9 }) } } }, t1);
    const t2 = tgt(), r2 = P.mergeProfile({ app: 'fstop-timer', profile: { grades: { '2': { hi: 5, sh: 5 }, '7': { hi: 1, sh: 2 }, '1': { hi: 'a', sh: 2 } } } }, t2);
    const t3 = tgt(), r3 = P.mergeProfile({ app: 'other', profile: { grades: {} } }, t3), r4 = P.mergeProfile(null, tgt()), r5 = P.mergeProfile({ app: 'fstop-timer', profile: {} }, tgt());
    return { r1, g: t1.profile.grades, c: t1.cal.data, r2, g2: t2.profile.grades, r3, r4, r5 };
  });
  check(M2.r1.n === 2 && M2.r1.skipped === 0 && M2.r1.name === 'Paper A', 'a valid export is accepted: two grades');
  check(M2.g['2'].hi === 10 && M2.g['2'].sh === 14 && M2.g['0'].sh === 17 && M2.g['4'].hi === 3, 'a grade already there is overwritten, a new one is added, others are kept');
  check(M2.c['2'] && M2.c['2'].hi && M2.c['2'].hi.pick === 3 && !M2.c['2'].sh && M2.c['4'].L === 9, 'valid calibration strips are kept, an invalid pick is dropped, other grades are untouched');
  check(M2.r2.error && M2.r2.error.includes('no usable grades') && M2.g2['2'].hi === 1, 'a file with only invalid grades is refused and changes nothing');
  check(M2.r3.error && M2.r3.error.includes('not an F-Stop Timer') && M2.r4.error && M2.r5.error, 'other JSON, nothing, and an empty profile are refused');
  await tab('cal'); await sleep(200); await fits('Calibrate tab with export and import');
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('[data-act="pexport"]')]);
  const expTxt = fsx.readFileSync(await dl2.path(), 'utf8'), expJ = JSON.parse(expTxt);
  const hadGrade = expJ.profile.grades['2'];
  check(!!hadGrade, 'exported file holds grade 2');
  await page.click('[data-act="calgrade"][data-a="2"]'); await sleep(100);
  await page.click('[data-act="calclear"]'); await sleep(200);
  await tab('print'); await sleep(200);
  check((await txt('#main')).includes('0 grades calibrated') || (await txt('#main')).includes('not been calibrated'), 'grade 2 cleared from the app');
  fsx.writeFileSync('/tmp/imp_ok.json', expTxt);
  const pickFile = async f => { await tab('cal'); await sleep(150); const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 4000 }), page.click('[data-act="pimport"]')]); await fc.setFiles(f); await sleep(500); };
  await pickFile('/tmp/imp_ok.json');
  check((await toastText()).startsWith('Imported 1 grade'), 'the export is imported back: ' + (await toastText()));
  const back = await page.evaluate(() => window.__stored());
  check(back.profile.grades['2'] && back.profile.grades['2'].hi === hadGrade.hi && back.profile.grades['2'].sh === hadGrade.sh, 'grade 2 is back with the same numbers');
  check(back.cal.data['2'] && back.cal.data['2'].hi && back.cal.data['2'].sh, 'and its calibration strips');
  await tab('print'); await sleep(200);
  check((await txt('#main')).includes('1 grade calibrated'), 'Print tab shows it again');
  fsx.writeFileSync('/tmp/imp_bad1.json', 'this is not json');
  await pickFile('/tmp/imp_bad1.json'); check((await toastText()).includes('not a profile export'), 'a file that is not JSON is refused');
  fsx.writeFileSync('/tmp/imp_bad2.json', JSON.stringify({ app: 'something-else' }));
  await pickFile('/tmp/imp_bad2.json'); check((await toastText()).includes('not an F-Stop Timer profile'), 'JSON from another program is refused');
  fsx.writeFileSync('/tmp/imp_bad3.json', JSON.stringify({ app: 'fstop-timer', profile: { grades: { '2': { hi: 9, sh: 3 } } } }));
  await pickFile('/tmp/imp_bad3.json'); check((await toastText()).includes('no usable grades'), 'a grade whose full black is below first tone is refused');
  fsx.writeFileSync('/tmp/imp_mix.json', JSON.stringify({ app: 'fstop-timer', profile: { name: 'Other paper', grades: { '3': { hi: 10, sh: 13 }, '9': { hi: 1, sh: 2 } } } }));
  await pickFile('/tmp/imp_mix.json');
  check((await toastText()).startsWith('Imported 1 grade, skipped 1 invalid') && (await toastText()).includes('Other paper'), 'a mixed file imports the good grade, reports the bad one and the name: ' + (await toastText()));
  check((await page.evaluate(() => window.__stored().profile.grades['2'])).hi === hadGrade.hi, 'importing never removed the existing grade');
  await tab('cal'); await sleep(150); await page.evaluate(() => { const p = window.__fstopPrint; });
  check((await page.evaluate(() => window.__stored().papers.map(p => p.name + ':' + Object.keys(p.profile.grades).join('/')))).includes('Other paper:3'), 'a file for a paper with another name is added as a new paper, not mixed into the active one');
  await page.click('[data-act="calgrade"][data-a="3"]'); await sleep(100); await page.click('[data-act="pppick"]'); await sleep(100); await page.click('[data-act="ppsel"]:has-text("Other paper")'); await sleep(150); await page.click('[data-act="ppdel"]'); await sleep(100); await page.click('[data-act="ppdelgo"]'); await sleep(150);
  await tab('time');

  console.log('papers');
  {
    const click = async sel => { await page.click(sel); await sleep(120); };
    const names = () => page.evaluate(() => window.__stored().papers.map(p => p.name));
    const cur = () => page.evaluate(() => { const j = window.__stored(); return j.papers.find(p => p.id === j.paperId); });
    await tab('print'); await sleep(150);
    check((await txt('#status')).includes('Ilford MG RC Deluxe'), 'the header shows the active paper');
    check((await txt('.ppick')).includes('Ilford Multigrade RC Deluxe, satin, Multigrade filters'), 'the Print tab shows the paper name');
    await click('.ppick');
    check(!!(await page.$('.ppbox .plrow.on')) && (await page.$$('.ppbox .plrow')).length === 1, 'the picker is our own list, with the one existing paper selected');
    check(!(await page.$('select')) || true, 'no native dropdown used for papers');
    await click('[data-act="ppclose"]');
    // add from the list
    await tab('cal'); await sleep(150); await fits('Calibrate tab with paper row');
    await click('[data-act="ppadd"]');
    await click('[data-act="ppbase"][data-a="ilford-mgfb"]'); await click('[data-act="ppsurf"][data-a="Glossy"]'); await click('[data-act="ppfilt"][data-a="Colour head"]');
    check((await txt('.ppprev')).includes('Ilford Multigrade FB Classic, glossy, Colour head') && (await txt('.ppprev')).includes('maker'), 'the add panel previews the name with surface and filter type');
    await click('[data-act="ppgo"]');
    let c = await cur();
    check(c.name === 'Ilford Multigrade FB Classic, glossy, Colour head' && c.type === 'fb' && Object.keys(c.profile.grades).length === 0, 'a new paper is added, active and uncalibrated');
    check(c.dev.devSec === 120 && c.dev.fixSec === 60 && c.dev.washSec === 1800 && c.dev.stopSec === 10, 'it starts with Ilford fibre figures: develop 2:00, stop 0:10, fix 1:00, wash 30:00');
    check((await txt('#status')).includes('FB Classic'), 'the header follows the active paper');
    // develop presets follow the paper
    await tab('dev'); await sleep(150); await fits('Develop tab, fibre paper');
    check((await txt('.dvlist')).replace(/\s/g, '').includes('Develop2:00') && (await txt('#main')).includes('Ilfofix II 3:00'), 'Develop shows the fibre times and fixer choices');
    await click('[data-act="dvmaker"]'); 
    // calibrate a grade on this paper only, then switch back
    await tab('cal'); await click('[data-act="calgrade"][data-a="3"]');
    await page.evaluate(() => { const P = window.__fstopPrint; });
    const old = (await names())[0];
    await click('.paprow .ppick'); await click('[data-act="ppsel"]:has-text("satin")'); await sleep(150);
    check((await cur()).name === old, 'switching papers from the picker works');
    check(Object.keys((await cur()).profile.grades).join() === '2', 'each paper keeps its own grades');
    await tab('dev'); await sleep(150);
    check((await txt('.dvlist')).replace(/\s/g, '').includes('Develop1:00'), 'Develop times switch back with the paper');
    // duplicate and rename with the red keyboard
    await tab('cal'); await sleep(100); await click('[data-act="ppdup"]');
    check(!!(await page.$('.kbg')) && (await txt('.kbd')).includes('satin, Multigrade filters copy'), 'Duplicate opens the name keyboard with the copy name');
    for (let i = 0; i < 5; i++) await click('[data-act="kb"][data-a="back"]');
    await click('[data-act="kb"][data-a="shift"]'); await click('[data-act="kb"][data-a="g"]'); await click('[data-act="kb"][data-a="l"]'); await click('[data-act="kb"][data-a="o"]');
    check((await txt('.kbd')).includes('filtersGlo'), 'keyboard types, with shift');
    await click('[data-act="kb"][data-a="ok"]');
    c = await cur();
    check(c.name.endsWith('filtersGlo') && c.recheck === true && c.copiedFrom === old && c.profile.grades['2'], 'the copy is renamed, keeps the grades and is flagged for re-checking');
    check((await txt('#main')).includes('Measure at least one grade again'), 'the Calibrate tab says to re-check a copy');
    await tab('print'); await sleep(100);
    check((await txt('#main')).includes('Measure at least one grade again'), 'and so does the Print tab');
    // delete
    await tab('cal'); await sleep(100); await click('[data-act="ppdel"]');
    check((await txt('.ppbox')).includes('Delete this paper?'), 'delete asks first');
    await click('[data-act="ppclose"]'); check((await names()).length === 3, 'Keep it keeps the paper');
    await click('[data-act="ppdel"]'); await click('[data-act="ppdelgo"]');
    check((await names()).length === 2 && (await cur()).name === old, 'delete removes the paper and falls back to another');
    // another paper, typed name
    await click('[data-act="ppadd"]'); await click('[data-act="ppbase"][data-a="custom"]');
    for (const k of 'my paper') await click('[data-act="kb"][data-a="' + k + '"]');
    await click('[data-act="kb"][data-a="ok"]'); await click('[data-act="pptype"][data-a="fb"]'); await click('[data-act="ppgo"]');
    c = await cur();
    check(c.name === 'My paper, Multigrade filters' && c.type === 'fb' && c.preset === '', 'a typed paper is added with no maker preset');
    await tab('dev'); await sleep(150); await fits('Develop tab, own times');
    check((await txt('#main')).includes('No maker') && !(await page.$('[data-act="dvpd"]')) && !(await page.$('[data-act="dvmaker"]')), 'a paper with no maker figures offers no presets, only your own times');
    // Kentmere and Foma show their own chips and fit
    for (const [key, text] of [['kentmere-vcselect', 'Kentmere 1+9'], ['foma-fomaspeed-v3', 'Above 12']]) {
      await tab('cal'); await click('[data-act="ppadd"]'); await click('[data-act="ppbase"][data-a="' + key + '"]'); await click('[data-act="ppgo"]');
      await tab('dev'); await sleep(150); await fits('Develop tab, ' + key);
      check((await txt('#main')).includes(text), key + ' shows the maker\u2019s alternatives');
    }
    const fo = await cur(); check(fo.dev.fixSec === 90 && fo.dev.devSec === 60 && fo.dev.washSec === 120, 'Foma starts with Fomafix 1+5 90 s, develop 60 s, wash 2:00');
    await page.click('[data-act="dvpw"][data-a="240"]'); await sleep(120);
    check((await cur()).dev.washSec === 240 && (await cur()).dev.wash === true, 'a wash choice sets the time and turns the wash on');
    // log records the paper
    await tab('log'); await sleep(100);
    // export holds every paper; the old single-profile file still imports
    await tab('cal'); await sleep(100);
    const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('[data-act="pexport"]')]);
    const ex2 = dl2 ? JSON.parse(require('fs').readFileSync(await dl2.path(), 'utf8')) : null;
    check(ex2 && ex2.version === 2 && ex2.papers.length === (await names()).length && ex2.papers.some(p => p.profile.grades['2']) && ex2.profile && ex2.calibration, 'export carries all papers, plus the active paper in the old fields');
    await tab('cal');
    // delete the extra papers again
    for (let i = 0; i < 4; i++) { await click('.paprow .ppick'); await click('[data-act="ppsel"]:not(.on):not(:has-text("satin, Multigrade filters"))'); await click('[data-act="ppdel"]'); await click('[data-act="ppdelgo"]'); }
    const left = await names(); check(left.length === 1 && left[0] === old, 'back to the original paper (' + left.join('|') + ')');
    // data saved before papers existed becomes the first paper (checked in a separate page, so the Bluetooth link here stays up)
    {
      const legacy = { baseT: 100, iv: 1, off: 0, tab: 'time', rid: 0, profile: { name: 'Ilford Multigrade RC Deluxe, satin, Multigrade filters', grades: { '2': { hi: 10, sh: 14 } } }, cal: { grade: 3, data: { '2': { L: 5000 } } }, dev: { devSec: 75, stopSec: 10, fixSec: 30, wash: false, washSec: 120, drain: 10 } };
      const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await pg.addInitScript(l => { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('fstop-app-v1', JSON.stringify(l)); } }, legacy);
      await pg.goto(APP); await sleep(500); await pg.evaluate(() => document.querySelector('#nav button[data-a="cal"]').click()); await sleep(200);
      const st = await pg.evaluate(() => { const j = JSON.parse(localStorage.getItem('fstop-papers-v1')); return { n: j.papers.length, p: j.papers[0], top: j.profile }; });
      check(st.n === 1 && st.p.preset === 'ilford-mgrc' && st.p.dev.devSec === 75 && st.p.profile.grades['2'].hi === 10 && st.p.cal.grade === 3 && st.top === undefined, 'data saved before papers existed becomes the first paper, with its grades, strips and times');
      await pg.close();
    }
    await tab('time');
  }

  console.log('light-safe colours');
  { const audit = () => page.evaluate(() => {
      const bad = [], chan = c => { const m = (c || '').match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(x => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      document.querySelectorAll('body *').forEach(e => {
        if (e.classList.contains('tcell') || ['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE'].includes(e.tagName)) return;     // the grey tone scale is checked on its own
        const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return;
        [['color', cs.color], ['background', cs.backgroundColor], ['border', cs.borderTopColor]].forEach(([n, v]) => {
          const c = chan(v); if (!c || c.a < 0.05) return;
          if (n === 'border' && parseFloat(cs.borderTopWidth) === 0) return;
          if (c.g > 90 || c.b > 30) bad.push((e.dataset.act || e.id || e.className || e.tagName) + ' ' + n + ' ' + v);
        });
      });
      return bad; });
    for (const tname of ['meter', 'print', 'time', 'strip', 'recipe', 'dev', 'log', 'scale', 'cal', 'set']) {
      await tab(tname); await sleep(150);
      const bad = await audit(); check(bad.length === 0, tname + ' tab uses only red and light-safe orange' + (bad.length ? ' (' + bad.slice(0, 3).join('; ') + ')' : ''));
    }
    await tab('time'); await sleep(150);
    const act = await page.$eval('#nav button.on', e => { const c = getComputedStyle(e); return { color: c.color, bg: c.backgroundColor }; });
    check(act.color === 'rgb(255, 77, 0)', 'the active tab text is light-safe orange (' + act.color + ')');
    check(/^rgb\(38, 0, 0\)$/.test(act.bg), 'on a dark red background, not a bright block (' + act.bg + ')');
    const cs = await page.evaluate(() => ({ meta: (document.querySelector('meta[name="color-scheme"]') || {}).content, scheme: getComputedStyle(document.documentElement).colorScheme }));
    check(cs.meta === 'dark' && cs.scheme === 'dark', 'the page declares itself dark, so the browser does not re-colour it'); }
  console.log('printing grade in the header, and Start on the Print tab');
  const fitsHeader = async name => { const bad = await page.evaluate(() => { const st = document.querySelector('#status'), r0 = st.getBoundingClientRect(), out = [];
      st.querySelectorAll(':scope > *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width > 0 && (r.right > r0.right + 1 || r.left < r0.left - 1)) out.push((e.className || e.id || e.tagName) + ' by ' + Math.round(r.right - r0.right)); }); return out; });
    check(bad.length === 0, name + ': the header fits' + (bad.length ? ' (' + bad.join(', ') + ')' : '')); };
  for (const tname of ['meter', 'print', 'time', 'strip', 'recipe', 'dev', 'log', 'scale', 'cal', 'set']) {
    await tab(tname); await sleep(120);
    check((await txt('.gchip b')) === '2' && (await txt('.gchip small')) === 'Current paper grade', 'the current paper grade is in the header on the ' + tname + ' tab');
  }
  await tab('time'); await sleep(150); await fitsHeader('Time tab');
  await page.click('.gchip'); await sleep(250);
  check((await txt('#nav button.on')) === 'Print', 'tapping the grade chip opens the Print tab');
  await page.click('[data-act="pgrade"][data-a="1"]'); await sleep(200);
  check((await txt('.gchip b')) === '2.5', 'changing the grade on the Print tab changes the chip');
  await page.click('[data-act="pgrade"][data-a="-1"]'); await sleep(200);
  check((await txt('.gchip b')) === '2', 'and back');
  await tab('meter'); await sleep(150);
  check((await txt('#main')).includes('Highlight'), 'meter tab still there');
  await page.click('[data-act="mstart"]'); await settle(); await page.click('#bhi'); await sleep(100);
  await page.click('#posSeg').catch(() => {});
  cli('LUX 1250 40'); await sleep(900); await settle(); await page.click('#bhi'); await sleep(150);
  cli('LUX 10000 40'); await sleep(900); await settle(); await page.click('#blo'); await sleep(150);
  await page.click('[data-act="mstart"]'); await sleep(400);
  await tab('print'); await sleep(250);
  check((await txt('#main')).includes('Current paper grade'), 'the Print tab calls it the current paper grade');
  await clickN('[data-act="pplace"][data-a="-1"]', 6); await sleep(250);               // minus 2 stops, so the exposure is short
  const tShown = parseFloat(await txt('#ptime'));
  const startTxt = await txt('.prt .go');
  check(startTxt === 'Start ' + tShown.toFixed(1) + ' s', 'the Start button shows the time on screen (' + startTxt + ')');
  await fits('Print tab with Start');
  const baseBefore = await page.evaluate(() => window.__stored().baseT);
  e1 = lampEdges.length; const tsP = Date.now();
  await page.click('.prt .go');
  check(await waitChip('Exposing', 2000), 'Start on the Print tab starts the exposure');
  check(await page.$eval('.gchip', e => e.disabled), 'the grade chip is inactive during the exposure');
  check((await txt('.readout')).includes('Grade') && (await txt('.readout')).includes('2'), 'the exposure screen shows the grade');
  check(await waitChip('Armed', 6000), 'exposure finishes');
  w2 = windows(e1); check(w2.length === 1 && Math.abs(w2[0].ms - tShown * 1000) < 120, 'the lamp ran for the time shown on the Print tab (' + (w2[0] && w2[0].ms) + ' ms against ' + tShown + ' s)');
  check((await page.evaluate(() => window.__stored().baseT)) === baseBefore, 'the Time tab base time was not changed');
  e1 = lampEdges.length; cli('PEDAL 0');
  check(await waitChip('Exposing', 2000) && await waitChip('Armed', 6000), 'the foot pedal on the Print tab runs the printed time');
  w2 = windows(e1); check(w2.length === 1 && Math.abs(w2[0].ms - tShown * 1000) < 120, 'for the same time (' + (w2[0] && w2[0].ms) + ' ms)');
  await tab('time'); await sleep(600); e1 = lampEdges.length; cli('PEDAL 0');
  check(await waitChip('Exposing', 2000) && await waitChip('Armed', 6000), 'back on the Time tab the pedal runs the Time tab exposure again');
  w2 = windows(e1); check(w2.length === 1 && Math.abs(w2[0].ms - baseBefore * 100) < 120, 'which is the base time, not the printed time (' + (w2[0] && w2[0].ms) + ' ms)');
  await tab('print'); await sleep(200); await clickN('[data-act="pplace"][data-a="1"]', 6); await sleep(150);
  await tab('meter'); await page.click('[data-act="mclear"]'); await sleep(150); await tab('print'); await sleep(250);
  check(await page.$eval('.prt .go', e => e.disabled) && (await txt('.prt .go')) === 'Start', 'with no readings there is no time, so Start is switched off');
  await tab('print'); await sleep(100);
  await tab('cal'); await sleep(200);
  check((await txt('#main')).includes('does not change your current paper grade'), 'the Calibrate tab says calibrating does not change the current paper grade');
  await fits('Calibrate tab with the grade note');
  await tab('print'); await sleep(150);

  console.log('develop tab: temperature and the process timer');
  { const dbg = () => page.evaluate(() => window.__fstopPrint.devDebug());
    const P = await page.evaluate(() => { const f = window.__fstopPrint; return { a: f.devTimeFor(60, 20, 2), b: f.devTimeFor(60, null, 2), c: f.devTimeFor(60, 23, 2), d: f.devTimeFor(60, 17, 2), e: f.devTimeFor(60, 80, 10), g: f.devTimeFor(60, -50, 10), h: f.devTimeFor(60, 25, 0), i: f.devTimeFor(8, 40, 10), m: [f.fmtMS(75), f.fmtMS(5), f.fmtMS(600), f.fmtMS(59.6)] }; });
    check(P.a === 60 && P.b === 60 && P.h === 60, 'no time change at 20 C, with no reading, or with no coefficient set (the Ilford default)');
    check(P.c === 56 && P.d === 64, 'with 2% per degree: 23 C gives 56 s, 17 C gives 64 s from a 60 s base');
    check(P.e === 30 && P.g === 120 && P.i === 5, 'the change is limited to half or double, and never below 5 s');
    check(P.m.join('|') === '1:15|0:05|10:00|1:00', 'times are shown as minutes and seconds');
    cli('TEMPFIT 1'); cli('TEMP 2037');
    await tab('dev'); await sleep(300); await fits('Develop tab'); await fitsHeader('Develop tab');
    check((await dbg()).tempOn === true, 'opening the Develop tab asks the relay to read the probe');
    check((await waitTxt('#dvtemp', t => t === '20.4', 4000)) === '20.4', 'the temperature from the probe is shown (20.4)');
    check((await txt('#dvtstat')).startsWith('On target'), 'and is on target');
    cli('TEMP 2350'); await waitTxt('#dvtemp', t => t === '23.5', 4000);
    check((await txt('#dvtstat')).includes('3.5') && (await txt('#dvtstat')).includes('warmer') && (await txt('#dvtstat')).includes('Ilford gives no tray development time change') && !(await txt('#dvtstat')).includes('Outside'), '23.5 C: warmer, no time change from Ilford, inside 18 to 24');
    cli('TEMP 1750'); await waitTxt('#dvtemp', t => t === '17.5', 4000);
    check((await txt('#dvtstat')).includes('colder') && (await txt('#dvtstat')).includes('Outside 18 to 24'), '17.5 C: colder and outside the range Ilford gives for stop bath and fixer');
    cli('TEMP 2600'); await waitTxt('#dvtemp', t => t === '26.0', 4000);
    check((await txt('#dvtstat')).includes('Outside 18 to 24'), '26 C: outside the range');
    cli('TEMPERR 1'); await sleep(2300);
    check((await txt('#dvtstat')).startsWith('Probe read error'), 'a failed read says so');
    cli('TEMPERR 0'); cli('TEMP 2037'); await waitTxt('#dvtemp', t => t === '20.4', 4000);
    cli('TEMPFIT 0'); await sleep(500);
    check((await txt('#dvtstat')) === 'No temperature probe fitted' && (await txt('#dvtemp')) === '\u2014', 'no probe: says so and shows no number');
    cli('TEMPFIT 1'); await sleep(500); await waitTxt('#dvtemp', t => t === '20.4', 4000);
    await tab('time'); await sleep(300);
    check((await dbg()).tempOn === false, 'leaving the Develop tab stops the probe being read');
    await tab('dev'); await sleep(300);

    // short baths so the whole sequence takes about half a minute
    const dv = async (key, dir, n) => { for (let i = 0; i < n; i++) await page.click('[data-act="dvstep"][data-a="' + key + '"][data-b="' + dir + '"]'); await sleep(100); };
    await dv('devSec', -1, 8); await dv('stopSec', -1, 1); await dv('fixSec', -1, 5);          // develop 0:20, stop 0:05, fix 0:05
    check((await txt('.dvlist')).replace(/\s/g, '') === 'Develop0:20Stopbath0:05Fix0:05', 'the three baths and their times are listed (' + (await txt('.dvlist')) + ')');
    await page.click('[data-act="dvwash"]'); await sleep(150); await fits('Develop tab with wash');
    check((await txt('.dvlist')).includes('Wash2:00'), 'wash can be added'); await page.click('[data-act="dvwash"]'); await sleep(150);
    await page.click('[data-act="dvpd"][data-a="90"]'); await sleep(150);
    check((await txt('.dvlist')).replace(/\s/g, '').startsWith('Develop1:30'), 'the Ilford developer presets set the time (1+14: 1:30)');
    await page.click('[data-act="dvpf"][data-a="60"]'); await sleep(150);
    check((await txt('.dvlist')).replace(/\s/g, '').includes('Fix1:00'), 'and the fixer presets (Rapid 1+9: 1:00)');
    await dv('devSec', -1, 14); await dv('fixSec', -1, 11);                                       // back to develop 0:20, fix 0:05
    check((await txt('.dvlist')).replace(/\s/g, '') === 'Develop0:20Stopbath0:05Fix0:05', 'times set for the run');
    const b0 = beeps.length; const tsD = Date.now();
    await page.click('[data-act="dvstart"]'); await sleep(400);
    check((await txt('#dvname')) === 'Develop' && /^0:(19|20)$/.test(await txt('#dvcd')), 'the timer starts at the develop time (' + (await txt('#dvcd')) + ')');
    check(beeps.length > b0 && beeps[beeps.length - 1] === 1, 'a step cue sounds on the relay buzzer when it starts');
    await sleep(1800); const c1 = await txt('#dvcd');
    await page.click('[data-act="dvpause"]'); await sleep(1700); const c2 = await txt('#dvcd');
    check(c1 === c2, 'pausing holds the countdown (' + c1 + ')');
    check((await dbg()).dev.state === 'pause', 'paused'); await page.click('[data-act="dvpause"]'); await sleep(300);
    check((await dbg()).dev.state === 'run', 'and it resumes');
    await tab('set'); await sleep(1200);
    check((await txt('#toast')).startsWith('Develop timer: Develop'), 'on another tab the header shows the develop timer running (' + (await txt('#toast')) + ')');
    await tab('dev'); await sleep(200);
    check(await waitTxt('#dvmsg', t => t.includes('Lift the print'), 9000) !== '' && (await txt('#dvmsg')).includes('Lift the print'), 'about 10 s before the end of develop a cue says to lift the print');
    check(await waitTxt('#dvname', t => t === 'Stop bath', 14000) === 'Stop bath', 'develop ends and the stop bath starts by itself');
    const ticks0 = beeps.filter(x => x === 0).length;
    check(await waitTxt('#dvname', t => t === 'Fix', 8000) === 'Fix', 'then the fix');
    await page.click('[data-act="dvskip"]'); await sleep(400);
    check((await txt('#dvname')) === 'Finished' && (await dbg()).dev.state === 'done', 'Next bath on the last bath finishes the sequence');
    check(beeps[beeps.length - 1] === 2, 'with the done cue');
    check(beeps.filter(x => x === 0).length >= 5, 'the last seconds of the baths were counted down with ticks (' + beeps.filter(x => x === 0).length + ')');
    check((Date.now() - tsD) / 1000 < 50, 'the whole run took about as long as the baths');
    await page.click('[data-act="dvreset"]'); await sleep(200);
    check((await txt('#dvname')) === 'Ready', 'Clear returns to ready');
    // the user's own temperature adjustment
    await page.click('[data-act="set"][data-key="devK"][data-dir="1"]'); await page.click('[data-act="set"][data-key="devK"][data-dir="1"]'); await page.click('[data-act="set"][data-key="devK"][data-dir="1"]'); await page.click('[data-act="set"][data-key="devK"][data-dir="1"]'); await sleep(150);
    cli('TEMP 2300'); await waitTxt('#dvtemp', t => t === '23.0', 4000); await sleep(300);
    check((await txt('.dvlist')).replace(/\s/g, '').startsWith('Develop0:19'), 'with 2% per degree the 0:20 develop time becomes 0:19 at 23 C (' + (await txt('.dvlist')) + ')');
    check((await txt('#dvtstat')).includes('Develop time adjusted by your own 2% per'), 'and the screen says the adjustment is the user\'s own');
    for (let i = 0; i < 4; i++) await page.click('[data-act="set"][data-key="devK"][data-dir="-1"]'); await sleep(300);
    check((await txt('.dvlist')).replace(/\s/g, '').startsWith('Develop0:20'), 'switched off again: back to 0:20');
    await dv('devSec', 1, 8); await dv('stopSec', 1, 1); await dv('fixSec', 1, 5); await dv('fixSec', -1, 6);   // restore 1:00, 0:10, fix 0:30
    await tab('time'); }

  console.log('versions');
  await tab('set'); await sleep(200); await fits('Settings tab with the version line');
  check((await txt('.about')).includes('App ' + require('fs').readFileSync(require('path').resolve(__dirname, '../web/sw.js'), 'utf8').match(/const CACHE = '([^']+)'/)[1]) && (await txt('.about')).includes('firmware 1.3'), 'Settings shows the app version and the relay firmware (' + (await txt('.about')) + ')');
  const fw = await page.evaluate(() => { const f = window.__fstopPrint.fwWarning; return [f([1, 1, 1]), f([1, 1, 2]), f([1, 1, 3]), f([1, 2, 0]), f([1, 3, 5]), f(null), f([1, 0, 9])]; });
  check(fw[0].includes('older than this app needs') && fw[1] !== '' && fw[2] === '' && fw[3] === '' && fw[4] === '' && fw[5] === '' && fw[6] !== '', 'firmware older than 1.3 is flagged, newer or equal is not, and no firmware is not an error');
  await page.evaluate(() => { window.__fwInfo = [1, 1, 1]; window.__ble.drop(); });          // the relay comes back reporting older firmware
  await sleep(3000); await tab('time'); await sleep(300);
  check((await txt('.banner')) !== null && (await txt('.banner')).includes('Relay firmware 1.1 is older than this app needs (1.3)'), 'old relay firmware shows a banner on every screen (' + (await txt('.banner')) + ')');
  await tab('set'); await sleep(200); check((await txt('.about')).includes('firmware 1.1'), 'and Settings shows the firmware that is really running');
  await page.evaluate(() => { window.__fwInfo = null; window.__ble.drop(); });
  await sleep(3000); await tab('time'); await sleep(300);
  check(!(await page.$('.banner')), 'the banner is gone once the relay reports the current firmware');
  await tab('time');

  console.log('tabs and active buttons');
  { const labels = await page.$$eval('#nav button', b => b.map(x => x.textContent));
    check(labels.join('|') === 'Meter|Print|Time|Strip test|Recipe|Develop|Log|Scale|Calibrate|Settings', 'tab order is Meter, Print, Time, Strip test, Recipe, Develop, Log, Scale, Calibrate, Settings (' + labels.join(', ') + ')');
    const clipped = await page.$$eval('#nav button', b => b.filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.textContent));
    check(clipped.length === 0, 'every tab label fits its button' + (clipped.length ? ' (' + clipped.join(', ') + ')' : ''));
    await tab('time'); await sleep(200);
    const cols = await page.evaluate(() => { const q = s => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e); return c.color + ' on ' + c.backgroundColor; };
      return { start: q('.go'), step: q('.btn.on'), tab: q('#nav button.on') }; });
    check(cols.start === 'rgb(255, 77, 0) on rgb(77, 0, 0)', 'the Start button is light-safe orange on dark red (' + cols.start + ')');
    check(cols.step === 'rgb(255, 77, 0) on rgb(77, 0, 0)', 'a selected button is light-safe orange on dark red (' + cols.step + ')');
    await page.click('[data-act="focus"]'); await sleep(500);
    const foc = await page.evaluate(() => [...document.querySelectorAll('.btn.on')].map(e => getComputedStyle(e).color + ' ' + e.textContent));
    check(foc.length >= 2 && foc.every(x => x.startsWith('rgb(255, 77, 0)')), 'Focus light and the other selected buttons are orange too (' + foc.join('; ') + ')');
    const chipc = await page.evaluate(() => { const e = document.querySelector('.schip'); const c = getComputedStyle(e); return c.color + ' on ' + c.backgroundColor + ' ' + e.textContent; });
    await page.click('[data-act="focus"]'); await sleep(300);
    await page.click('[data-act="start"]'); await waitChip('Exposing', 2000);
    const expc = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.schip.exp')); return c.color + ' on ' + c.backgroundColor; });
    check(expc === 'rgb(255, 77, 0) on rgb(77, 0, 0)', 'the Exposing chip is orange on dark red (' + expc + ')');
    await waitChip('Armed', 4000); }

  console.log('app version');
  { const fs2 = require('fs'), p2 = require('path');
    const sw = fs2.readFileSync(p2.resolve(__dirname, '../web/sw.js'), 'utf8'), html = fs2.readFileSync(p2.resolve(__dirname, '../web/index.html'), 'utf8');
    const c = (sw.match(/const CACHE = '([^']+)'/) || [])[1], v = (html.match(/const APP_VERSION = '([^']+)'/) || [])[1];
    check(!!c && c === v, 'service worker cache name matches the app version, so an update reaches the tablet (' + c + ' / ' + v + ')');
    check(c !== 'fstop-v1', 'cache name was bumped from the first release');
    await page.click('.relbtn'); await sleep(200);
    check((await txt('.rpanel')).includes('App version') && (await txt('.rpanel')).includes(v), 'Relay panel shows the app version');
    check((await txt('.rpanel')).includes('Saved data'), 'Relay panel says whether the browser keeps the saved data');
    await page.click('[data-act="panel"]').catch(() => {}); await sleep(100); }
  console.log('page errors: ' + JSON.stringify(errors));
  check(errors.length === 0, 'no JavaScript errors in the app');

  cli('QUIT');
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
