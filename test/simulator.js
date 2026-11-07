// Drives simulator/fstop_timer_simulator_tablet.html like a person would, in a real browser:
// meter the light, zero the probe, calibrate two grades from developed strips, predict a print at a grade in between,
// expose it, and compare what the simulated paper did with what the Print tab predicted.
// Run: node test/simulator.js      (set SHOTS=1 to save screenshots to /tmp)
const path = require('path');
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/home/claude/.npm-global/lib/node_modules/playwright'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; console.log('  ok    ' + m); } else { fail++; console.log('  FAIL  ' + m); } };
const near = (a, b, t, m) => check(Math.abs(a - b) <= t, m + ' (got ' + (+a).toFixed(3) + ', expected ' + (+b).toFixed(3) + ' +/- ' + t + ')');

(async () => {
  const browser = await pw.chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../simulator/fstop_timer_simulator_tablet.html'));
  const txt = sel => page.$eval(sel, e => e.textContent).catch(() => null);
  const chip = () => page.$eval('.schip', e => e.textContent).catch(() => '');
  const waitChip = async (want, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await chip()) === want) return true; await sleep(60); } return false; };
  const waitTxt = async (sel, pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await txt(sel); if (t !== null && pred(t)) return t; await sleep(60); } return await txt(sel); };
  const tab = t => page.click('#nav button[data-a="' + t + '"]');
  const settle = () => waitTxt('#mstat', t => t === 'Steady', 9000);
  const setBase = async v => { await tab('time'); await page.click('[data-act="keypad"]'); for (const ch of String(v)) await page.click('[data-act="kp"][data-a="' + ch + '"]'); await page.click('[data-act="kp"][data-a="ok"]'); await sleep(250); };
  const fits = async name => { const bad = await page.evaluate('(' + (() => { const m = document.querySelector('#main'); const mb = m.getBoundingClientRect().bottom + 1, bad = []; m.querySelectorAll('*').forEach(e => { const r = e.getBoundingClientRect(); if (r.height > 0 && r.bottom > mb) bad.push((e.dataset.act || e.id || e.className || e.tagName) + ' by ' + Math.round(r.bottom - mb) + 'px'); const mr = m.getBoundingClientRect().right + 1; if (r.width > 0 && r.right > mr) bad.push((e.dataset.act || e.id || e.className || e.tagName) + ' sideways by ' + Math.round(r.right - mr) + 'px'); }); return bad; }).toString() + ')()'); check(bad.length === 0, name + ' fits above the tab bar' + (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : '')); };
  const shot = n => process.env.SHOTS ? page.screenshot({ path: '/tmp/sim_' + n + '.png', fullPage: true }) : null;

  console.log('splash screen');
  check(await page.$eval('#splash img', i => i.complete && i.naturalWidth > 0) && (await txt('#splash .stext')) === 'F-Stop Timer/Densitometer', 'the splash shows the picture and the name');
  const t0s = Date.now(); await page.waitForSelector('#splash', { state: 'detached', timeout: 6000 });
  check(Date.now() - t0s < 4500, 'with nobody touching it, the splash goes away by itself');
  console.log('connecting');
  await page.click('#modeSeg button[data-mode="wrapped"]');
  await page.click('#speedSeg button[data-speed="10"]');
  check(await waitTxt('.schip', t => t === 'Idle' || t === 'Armed', 8000) !== null, 'screen connects to the simulated relay');
  check((await txt('#rProbe')) === 'plugged in', 'relay panel shows the probe plugged in');

  console.log('metering');
  await tab('meter'); await sleep(300);
  await fits('Meter tab');
  check(await page.$eval('[data-act="mstart"]', e => !e.disabled), 'Start metering is available with a probe');
  await page.click('[data-act="mstart"]');
  check((await settle()) === 'Steady', 'reading settles');
  await fits('Meter tab while metering');
  check(await page.$eval('#lampEnl', e => e.classList.contains('on')) && !(await page.$eval('#lampSafe', e => e.classList.contains('on'))), 'enlarger on and safelight off while metering');
  check((await txt('#rMeter')).startsWith('lit'), 'relay panel shows lit metering');
  await page.click('#bhi'); await sleep(150);
  await page.click('#posSeg button[data-pos="sh"]'); await sleep(900); await settle();
  await page.click('#blo'); await sleep(200);
  const nums = await page.$$eval('#mtbl .num', els => els.map(e => e.textContent));
  check(nums[4] === '+3', 'shadow reads 3 stops above the highlight, as the simulated negative range is 3 (' + nums.join(' | ') + ')');
  await page.click('[data-act="mstart"]'); await sleep(500);
  check(!(await page.$eval('#lampEnl', e => e.classList.contains('on'))) && await page.$eval('#lampSafe', e => e.classList.contains('on')), 'metering off: enlarger off, safelight back on');
  await page.click('#posSeg button[data-pos="hi"]');

  console.log('zero the probe');
  await page.click('[data-act="mzero"]');
  const dz = await waitTxt('#toast', t => t.startsWith('Dark offset'), 8000);
  check(dz === 'Dark offset set to 0.03 lx', 'dark offset read as 0.03 lx (' + dz + ')');
  check(!(await page.$eval('#lampEnl', e => e.classList.contains('on'))), 'enlarger stayed off while zeroing');
  await page.click('[data-act="mclear"]');

  console.log('probe unplugged');
  await page.click('#swProbe'); await sleep(600);
  check((await txt('#mstat')) === 'No light probe fitted' && await page.$eval('[data-act="mstart"]', e => e.disabled), 'no probe: message shown and Start metering disabled');
  await page.click('#swProbe'); await sleep(600);

  console.log('develop tab');
  await tab('dev'); await sleep(300); await fits('Develop tab');
  const clippedTabs = await page.$$eval('#nav button', b => b.filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.textContent));
  check(clippedTabs.length === 0, 'all ten tab labels fit' + (clippedTabs.length ? ' (' + clippedTabs.join(', ') + ')' : ''));
  const setTemp = v => page.evaluate(v => { const r = document.getElementById('rngTemp'); r.value = v; r.dispatchEvent(new Event('input')); }, v);
  await setTemp(23.5); await waitTxt('#dvtemp', t => t === '23.5', 8000);
  check((await txt('#dvtemp')) === '23.5' && (await txt('#dvtstat')).includes('warmer'), 'the bench temperature reaches the Develop tab (23.5, warmer than 20)');
  await setTemp(17); await waitTxt('#dvtemp', t => t === '17.0', 8000);
  check((await txt('#dvtstat')).includes('Outside 18 to 24'), '17 C is flagged as outside the range Ilford gives for stop bath and fixer');
  await page.click('#swTemp'); await sleep(900);
  check((await txt('#dvtstat')) === 'No temperature probe fitted', 'unplugging the temperature probe says so');
  await page.click('#swTemp'); await setTemp(20); await waitTxt('#dvtemp', t => t === '20.0', 8000);
  check((await txt('#dvtstat')).startsWith('On target'), 'plugged back in, 20 C is on target');
  await page.click('[data-act="dvstart"]'); await sleep(500);
  check((await txt('#dvname')) === 'Develop', 'the process timer starts with the developer');
  await page.click('[data-act="dvpause"]'); await sleep(300); const cp1 = await txt('#dvcd'); await sleep(1300);
  check((await txt('#dvcd')) === cp1, 'pause holds the countdown'); await page.click('[data-act="dvpause"]'); await sleep(200);
  await tab('set'); await sleep(900);
  check((await txt('#toast')).startsWith('Develop timer: Develop'), 'the header shows the running develop timer on other tabs');
  await tab('dev'); await page.click('[data-act="dvskip"]'); await sleep(250);
  check((await txt('#dvname')) === 'Stop bath', 'Next bath moves to the stop bath');
  await page.click('[data-act="dvskip"]'); await sleep(200); await page.click('[data-act="dvskip"]'); await sleep(300);
  check((await txt('#dvname')) === 'Finished', 'and through the fix to the end'); await page.click('[data-act="dvreset"]'); await sleep(200);
  check((await txt('#dvname')) === 'Ready', 'cleared');
  await tab('time');

  console.log('versions');
  await tab('set'); await sleep(200);
  check((await txt('.about')).includes('App fstop-v'), 'Settings shows the app version (' + (await txt('.about')) + ')');
  check((await txt('#simVer')).includes('fstop-v'), 'the simulator page shows its build');
  await fits('Settings tab with the version line');

  console.log('shake delay');
  await page.click('#speedSeg button[data-speed="1"]');
  await tab('set'); await fits('Settings tab');
  for (let i = 0; i < 2; i++) await page.click('[data-act="set"][data-key="shakeT"][data-dir="1"]');
  await sleep(300);
  await setBase('0.5'); await tab('time'); await page.click('[data-act="off0"]'); await sleep(150);
  await page.click('[data-act="start"]');
  check(await waitChip('Waiting', 1500), 'status shows Waiting after Start');
  await sleep(600);
  check((await chip()) === 'Waiting' && !(await page.$eval('#lampEnl', e => e.classList.contains('on'))), 'still waiting after 0.6 s, enlarger off');
  check((await txt('#main')).includes('Waiting for vibrations to settle') && await page.$eval('[data-act="pause"]', e => e.disabled), 'screen explains the wait and Pause is not offered');
  check(await waitChip('Exposing', 3000) && await page.$eval('#lampEnl', e => e.classList.contains('on')), 'exposure starts when the 1.0 s wait is over');
  check(await waitChip('Armed', 4000), 'exposure finishes');
  await page.click('[data-act="start"]'); check(await waitChip('Waiting', 1500), 'second run waits too');
  await page.click('[data-act="cancel"]'); check(await waitChip('Armed', 1500) && !(await page.$eval('#lampEnl', e => e.classList.contains('on'))), 'cancel during the wait: back to Armed, enlarger never came on');
  await tab('set'); for (let i = 0; i < 2; i++) await page.click('[data-act="set"][data-key="shakeT"][data-dir="-1"]'); await sleep(200);
  await tab('cal'); await sleep(250);
  check(await page.$eval('[data-act="pimport"]', e => !e.disabled) && await page.$eval('[data-act="calgrade"][data-a="2"]', e => !e.disabled), 'the Calibrate tab offers Import profile and the grade chips');
  await fits('Calibrate tab');
  await page.click('#speedSeg button[data-speed="10"]');

  console.log('calibrating two grades from developed strips');
  const calibrate = async p => {
    await page.selectOption('#benchGrade', String(p));
    await page.evaluate(() => { __sim.Bench.neg.in = false; document.getElementById('swNeg').checked = false; });      // blank paper
    await tab('cal'); await sleep(200);
    await page.click('[data-act="calgrade"][data-a="' + p + '"]'); await sleep(150);
    await page.click('[data-act="mstart"]'); await waitTxt('#calstat', t => t === 'Steady', 9000);
    await page.click('#bcalL'); await sleep(150); await page.click('[data-act="mstart"]'); await sleep(300);
    for (const kind of ['hi', 'sh']) {
      const L = await page.evaluate(() => __sim.Bench.light('open'));
      const dose = await page.evaluate(([k, p]) => Math.pow(2, k === 'hi' ? __sim.Paper.hi(p) : __sim.Paper.sh(p)), [kind, p]);
      const tb = kind === 'hi' ? dose / L / Math.pow(2, 2 / 3) : dose / L / 2;       // put the true answer near the middle of the six strips
      await setBase(Math.max(0.5, tb).toFixed(1)); await tab('cal'); await sleep(150);
      await page.click('[data-act="calstrip"][data-a="' + kind + '"]'); await sleep(250);
      await page.click('[data-act="start"]'); await waitChip('Exposing', 4000);
      check(await waitChip('Armed', 60000), 'grade ' + p + ' ' + kind + ' strip test finishes');
      await sleep(400);
      const sw = (await page.$$eval('#paperOut .swc', els => els.map(e => ({ f: +e.querySelector('.sw').dataset.f, n: e.querySelector('span').textContent })))).filter(x => x.n.startsWith('strip'));
      check(sw.length === 6, 'six strips developed (' + kind + ')');
      const pick = sw.find(x => x.f >= (kind === 'hi' ? 0.08 : 0.97));
      check(!!pick, 'a strip shows ' + (kind === 'hi' ? 'the first tone' : 'full black') + ' (' + (pick ? pick.n : 'none') + ')');
      if (kind === 'hi') await shot('strips');
      await fits('wizard with developed strips (' + kind + ')');
      await page.click('[data-act="calpick"][data-a="' + kind + '"][data-b="' + pick.n.replace('strip ', '') + '"]'); await sleep(200);
    }
    await page.evaluate(() => { __sim.Bench.neg.in = true; document.getElementById('swNeg').checked = true; });
  };
  await calibrate(2); await calibrate(4);
  const grades = await page.evaluate(() => Object.keys(__sim.A.profile.grades));
  check(grades.includes('2') && grades.includes('4'), 'grades 2 and 4 are saved in the profile');
  const err = await page.evaluate(() => [2, 4].map(p => { const g = __sim.A.profile.grades[String(p)]; return [g.hi - __sim.Paper.hi(p), g.sh - __sim.Paper.sh(p)]; }));
  err.forEach((e, i) => { near(e[0], 0, 0.45, 'grade ' + [2, 4][i] + ' first tone close to the simulated paper (stops)'); near(e[1], 0, 0.45, 'grade ' + [2, 4][i] + ' full black close to the simulated paper (stops)'); });
  check((await txt('#checkOut')).includes('Grade') || (await page.$eval('#checkOut', e => e.textContent)).includes('stops'), 'calibration check table is filled in');

  console.log('predicting a print at grade 3 (not calibrated, interpolated)');
  await page.selectOption('#benchGrade', '3');
  await tab('meter'); await page.click('[data-act="mstart"]'); await settle();
  await page.click('#bhi'); await sleep(150);
  await page.click('#posSeg button[data-pos="sh"]'); await sleep(900); await settle(); await page.click('#blo'); await sleep(150);
  await page.click('[data-act="mstart"]'); await sleep(400);
  await tab('print'); await sleep(200);
  await page.click('[data-act="pgrade"][data-a="1"]'); await page.click('[data-act="pgrade"][data-a="1"]'); await sleep(250);
  check((await txt('#main')).includes('interpolated'), 'grade 3 is shown as interpolated');
  const tPred = parseFloat(await txt('#ptime'));
  const tTrue = await page.evaluate(() => Math.pow(2, __sim.Paper.hi(3)) / __sim.Bench.light('hi'));
  check(tPred / tTrue > 0.7 && tPred / tTrue < 1.42, 'calculated time is within half a stop of the true first-tone time (' + tPred.toFixed(1) + ' s against ' + tTrue.toFixed(1) + ' s)');
  check(await page.$eval('.tcell', e => /^rgb\(\d+, 0, 0\)$/.test(getComputedStyle(e).backgroundColor)) && (await txt('#main')).includes('The red film is on'), 'with the red film over the screen the grey scale shows red, and says why');
  await page.evaluate(() => { __sim.A.tablet.filter = false; __sim.save(); __sim.renderAll(); }); await sleep(200);
  check(await page.$eval('.tscale', e => e.dataset.mode) === 'grey' && await page.$eval('.tcell', e => /^rgb\((\d+), \1, \1\)$/.test(getComputedStyle(e).backgroundColor)), 'with the film off the scale is neutral grey');
  await fits('Print tab'); await shot('print');
  const predSh = await page.evaluate(() => { const ps = __sim.printState(); return Math.log2(ps.Ls * ps.t) - ps.d.sh; });
  check((await txt('.gchip b')) === '3' && (await txt('.gchip small')) === 'Current paper grade', 'the current paper grade is shown in the header');
  const baseBefore = await page.evaluate(() => __sim.A.baseT);
  const startLabel = await txt('.prt .go'); check(startLabel === 'Start ' + tPred.toFixed(1) + ' s', 'Start on the Print tab shows the printed time (' + startLabel + ')');
  await page.click('.prt .go');
  check(await waitChip('Exposing', 4000), 'print exposure starts from the Print tab');
  check((await page.evaluate(() => __sim.A.baseT)) === baseBefore, 'the Time tab base time is unchanged');
  await sleep(300);
  check(await page.$eval('.tscale', e => e.dataset.mode).catch(() => null) === 'red', 'red tone scale on the exposure screen');
  check((await txt('.readout')).includes('Grade') && (await txt('.readout')).includes('3'), 'the exposure screen shows the printing grade');
  check(await waitChip('Armed', 90000), 'print exposure finishes');
  await sleep(400);
  const act = await page.evaluate(() => ({ hi: Math.log2(__sim.Bench.result.dose.hi) - __sim.Paper.hi(3), sh: Math.log2(__sim.Bench.result.dose.sh) - __sim.Paper.sh(3), fh: +document.querySelectorAll('#paperOut .sw')[1].dataset.f }));
  near(act.hi, 0, 0.5, 'developed print: highlight lands at first tone, as asked (stops above first tone)');
  near(act.sh - predSh, 0, 0.5, 'developed print: shadow lands where the Print tab predicted (stops from full black)');
  check(act.fh < 0.2, 'highlight patch on the dry print is a faint tone');
  await shot('bench');

  check(errors.length === 0, 'no JavaScript errors (' + errors.join('; ') + ')');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
