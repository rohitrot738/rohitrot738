#!/usr/bin/env node
// Runs the debug build of the app on an Android emulator and checks, from inside its page, the things that only
// exist on a phone and that no test on a computer can see: that the page reaches the native side at all, that the
// full-screen clock hides the phone's bars and fills the screen whatever font size the phone is set to, and that a
// journey goes on being recorded natively with the screen off.
//
// The page is driven through the WebView's own debugging socket (Chrome DevTools Protocol, open in debug builds).
// Screenshots are saved to e2e-shots/ and also printed to the log, small, as lines of "SHOT <name> <base64>".
//
// Usage: node scripts/android_e2e.mjs path/to/app-debug.apk   (an emulator must be running and seen by adb)
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

const PACKAGE = 'com.railtrack.app';
const PORT = 9333;
const apk = process.argv[2];
if (!apk || !fs.existsSync(apk)) { console.error('Give the path of the debug APK'); process.exit(2); }

const failures = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const adb = (...args) => execFileSync('adb', args, {encoding: 'utf8', maxBuffer: 64 << 20});
const shell = command => adb('shell', command).trim();
const quiet = fn => { try { return fn(); } catch (e) { return String(e.stderr || e.message || e).trim(); } };
function check(ok, what, detail = '') {
  log(ok ? 'PASS' : 'FAIL', what, detail);
  if (!ok) failures.push(what + (detail ? ' — ' + detail : ''));
}

// The least of a WebSocket client that the DevTools socket needs: one text message per frame each way.
class DevTools {
  static async open(url) {
    const {hostname, port, pathname} = new URL(url);
    const socket = net.connect(Number(port), hostname);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const tools = new DevTools(socket);
    await tools.ready;
    return tools;
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.upgraded = false;
    this.message = [];
    this.waiting = new Map();
    this.next = 0;
    this.ready = new Promise((resolve, reject) => { this.opened = resolve; this.failed = reject; });
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.read(); });
    socket.on('error', e => this.fail(e));
    socket.on('close', () => this.fail(new Error('DevTools socket closed')));
  }

  fail(error) {
    this.failed(error);
    for (const {reject} of this.waiting.values()) reject(error);
    this.waiting.clear();
  }

  read() {
    if (!this.upgraded) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString();
      this.buffer = this.buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) { this.fail(new Error('DevTools refused the socket: ' + head.split('\r\n')[0])); return; }
      this.upgraded = true;
      this.opened();
    }
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], second = this.buffer[1];
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      if (opcode === 9) { this.frame(10, payload); continue; }     // ping: answer it
      if (opcode !== 0 && opcode !== 1) continue;                  // pong, close, binary: nothing to do
      this.message.push(payload);
      if (!(first & 0x80)) continue;                               // more pieces of this message follow
      const text = Buffer.concat(this.message).toString();
      this.message = [];
      const answer = JSON.parse(text), waiting = this.waiting.get(answer.id);
      if (!waiting) continue;                                      // an event, not an answer
      this.waiting.delete(answer.id);
      if (answer.error) waiting.reject(new Error(answer.error.message)); else waiting.resolve(answer.result);
    }
  }

  frame(opcode, payload) {
    const mask = crypto.randomBytes(4), length = payload.length;
    const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([head, mask, masked]));
  }

  send(method, params = {}) {
    if (this.socket.destroyed) return Promise.reject(new Error('DevTools socket closed'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, {resolve, reject});
      this.frame(1, Buffer.from(JSON.stringify({id, method, params})));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`No answer to ${method} in 30 s`)); }, 30000);
    });
  }

  // Runs the statements in the page, as the body of an async function, and gives back what it returns.
  async run(body) {
    const answer = await this.send('Runtime.evaluate', {expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true});
    if (answer.exceptionDetails) {
      const e = answer.exceptionDetails;
      throw new Error('In the page: ' + (e.exception?.description || e.text));
    }
    return answer.result.value;
  }

  close() { this.socket.destroy(); }
}

// Opens the app's page for driving: finds the WebView's debugging socket, forwards it, and connects.
async function openPage() {
  let last = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(1500);
    try {
      const unix = shell('cat /proc/net/unix');
      const pid = shell(`pidof ${PACKAGE}`).split(/\s+/)[0];
      const names = [...unix.matchAll(/@(webview_devtools_remote_(\d+))/g)];
      const mine = names.find(match => match[2] === pid) || names[0];
      if (!mine) { last = 'no WebView debugging socket yet'; continue; }
      quiet(() => adb('forward', '--remove', `tcp:${PORT}`));
      adb('forward', `tcp:${PORT}`, `localabstract:${mine[1]}`);
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = pages.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl);
      if (!page) { last = 'no page listed: ' + JSON.stringify(pages).slice(0, 200); continue; }
      const tools = await DevTools.open(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
      await tools.send('Runtime.enable');
      // The page is ready once its station lists are in.
      for (let wait = 0; wait < 40; wait++) {
        const count = await tools.run(`return typeof stations === 'undefined' ? -1 : stations.length;`).catch(e => { last = e.message; return -1; });
        if (count > 5000) { log('page ready:', page.url, count, 'stations'); return tools; }
        await sleep(1000);
      }
      tools.close();
      last = 'the page never loaded its stations (' + last + ')';
    } catch (e) { last = e.message; }
  }
  throw new Error('Could not open the app page: ' + last);
}

function shot(name) {
  fs.mkdirSync('e2e-shots', {recursive: true});
  const file = `e2e-shots/${name}.png`;
  fs.writeFileSync(file, execFileSync('adb', ['exec-out', 'screencap', '-p'], {maxBuffer: 64 << 20}));
  // A small copy in the log, for reading the run where its files cannot be fetched.
  try {
    const small = execFileSync('convert', [file, '-resize', '50%', '-quality', '60', 'jpg:-'], {maxBuffer: 64 << 20});
    const text = small.toString('base64');
    for (let i = 0; i < text.length; i += 4000) console.log(`SHOT ${name} ${text.slice(i, i + 4000)}`);
    console.log(`SHOT ${name} END`);
  } catch (e) { log('no small copy of the screenshot (ImageMagick is not installed):', e.message.split('\n')[0]); }
  log('screenshot', file);
}

const deviceTime = () => Math.round(parseFloat(shell('echo $EPOCHREALTIME')) * 1000);
function launch() {
  adb('shell', 'am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`);
}
// What Android did with the app since the logs were last cleared: activities created, destroyed or relaunched,
// the process started or killed, crashes, configuration changes. For explaining a page that was reloaded.
function lifeEvents() {
  const events = quiet(() => adb('logcat', '-d', '-b', 'events', '-v', 'time')).split('\n')
    .filter(line => line.includes(PACKAGE) || /configuration_changed|am_crash|am_anr|am_low_memory/.test(line));
  const crashes = quiet(() => adb('logcat', '-d', '-b', 'crash', '-v', 'time')).split('\n').filter(Boolean);
  const system = quiet(() => adb('logcat', '-d', '-b', 'system', '-v', 'time')).split('\n')
    .filter(line => line.includes(PACKAGE) && /Kill|Start proc|died|crash|Relaunch|relaunch|config/i.test(line));
  return [...events.slice(-40), ...crashes.slice(-40), ...system.slice(-20)].join('\n') || '(none)';
}
// Whether the app is the activity in front, running (resumed).
const inFront = () => new RegExp(`(topResumedActivity|mResumedActivity)=[^\\n]*${PACKAGE.replace(/\./g, '\\.')}`)
  .test(quiet(() => shell('dumpsys activity activities')));
function setFix(lat, lon) { quiet(() => adb('emu', 'geo', 'fix', String(lon), String(lat))); }

// Where things are in the full-screen clock, in the page's own measure. "blank" is how much of the digits' line
// is empty above the digits themselves, on the screen: the line reaches further up than the ink does.
const CLOCK = `
  const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); };
  const dial = (r => [r.left, r.top, r.right, r.bottom].map(Math.round))(document.querySelector('.speedo').getBoundingClientRect());
  const time = document.getElementById('clock-time'), font = time.style.fontSize, scale = time.style.transform.match(/[\\d.]+/g).map(Number);
  const metrics = clockMetrics(time);
  time.style.fontSize = font;
  return {inner: [innerWidth, innerHeight], body: document.body.className, time: box('clock-time'), hm: box('clock-hm'),
    sec: box('clock-sec'), date: box('clock-date'), exit: box('clock-full'), dial, font, scale, metrics,
    blank: (metrics.foot - metrics.digit) * parseFloat(font) / 100 * scale[1]};`;
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

async function clockCheck(page, label) {
  const before = await page.run(`return [innerWidth, innerHeight];`);
  await page.run(`document.getElementById('speed').textContent = '105'; document.getElementById('clock-full').click();`);
  await sleep(2500);
  const clock = await page.run(CLOCK);
  log(label, 'clock:', JSON.stringify(clock), 'before:', JSON.stringify(before));
  shot(`clock-${label}`);
  const [width, height] = clock.inner, long = Math.max(width, height);
  check(/clockmode/.test(clock.body), `${label}: the clock is full screen`);
  check(height > before[1], `${label}: the phone's bars are hidden (the page grew taller)`, `${before[1]} -> ${height}`);
  // The time runs along the long side of the screen, edge to edge.
  const along = height > width ? [clock.time[1], clock.time[3]] : [clock.time[0], clock.time[2]];
  check(along[0] >= 8 && along[0] <= 16 && along[1] <= long - 8 && along[1] >= long - 16,
    `${label}: the time fills the screen from edge to edge`, `${along[0]} to ${along[1]} of ${long}`);
  // The digits themselves, without the empty top of their line: turned, the top of the line is its right side.
  const ink = [...clock.hm];
  if (height > width) ink[2] -= clock.blank; else ink[1] += clock.blank;
  check(!overlap(ink, clock.dial), `${label}: the hours and minutes stay clear of the speed dial`, `${JSON.stringify(ink.map(Math.round))} against ${JSON.stringify(clock.dial)}`);
  check(!overlap(clock.date, clock.dial) && !overlap(clock.exit, clock.dial), `${label}: the date and EXIT stay clear of the speed dial`);
  check(!overlap(clock.date, clock.hm) && !overlap(clock.exit, clock.date), `${label}: the date, EXIT and the time do not cover one another`);
  await page.run(`document.getElementById('clock-full').click();`);
  await sleep(2000);
  const after = await page.run(`return [innerWidth, innerHeight, document.body.className];`);
  check(after[2] === '' && after[1] === before[1], `${label}: EXIT brings the page and the phone's bars back`, JSON.stringify(after));
}

async function main() {
  log('installing', apk);
  adb('wait-for-device');
  quiet(() => adb('uninstall', PACKAGE));
  adb('install', '-g', apk);
  for (const permission of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'POST_NOTIFICATIONS'])
    log('grant', permission, quiet(() => adb('shell', 'pm', 'grant', PACKAGE, `android.permission.${permission}`)) || 'ok');
  // What the app would otherwise ask the user for when it opens: no battery restriction, location switched on.
  shell(`dumpsys deviceidle whitelist +${PACKAGE}`);
  quiet(() => shell('settings put secure location_mode 3'));
  quiet(() => shell('locksettings set-disabled true'));
  // Android's one-time "Viewing full screen" hint would cover the clock in the screenshots.
  quiet(() => shell('settings put secure immersive_mode_confirmations confirmed'));
  shell('input keyevent KEYCODE_WAKEUP');
  quiet(() => shell('wm dismiss-keyguard'));
  // A screen 360 wide in the page's measure, like the phone the trouble was seen on.
  const pixels = Number((shell('wm size').match(/(\d+)x\d+/) || [])[1]);
  if (pixels >= 720) shell(`wm density ${Math.round(pixels / 360 * 160)}`);
  log('screen:', shell('wm size').replace(/\n/g, ', '), '|', shell('wm density').replace(/\n/g, ', '));

  // ---- The phone's font size set to small, as on the phone where the clock came out too small.
  shell('settings put system font_scale 0.8');
  setFix(25.548889, 84.662596);
  launch();
  let page = await openPage();
  shot('home-small-font');

  const bridge = await page.run(`
    const c = window.Capacitor || {};
    return {registerPlugin: typeof c.registerPlugin, plugins: Object.keys(c.Plugins || {}),
      reach: !!nativePlugin('BackgroundGeolocation') && !!nativePlugin('SafarBuffer'),
      status: await nativePlugin('SafarBuffer')?.status?.()};`);
  log('bridge:', JSON.stringify(bridge));
  check(bridge.plugins.includes('BackgroundGeolocation') && bridge.plugins.includes('SafarBuffer'), 'the app offers its native plugins to the page');
  check(bridge.reach, 'the page reaches the native plugins');
  check(bridge.status && typeof bridge.status.version !== 'undefined', 'the native side answers the page', JSON.stringify(bridge.status));

  await clockCheck(page, 'small-font');

  // ---- A route, built in the app: the stations a link passes by are on it.
  await page.run(`
    document.getElementById('origin').value = 'PNBE';
    document.getElementById('destination').value = 'MGS';
    document.getElementById('find-route').click();`);
  let routeNames = [];
  for (let wait = 0; wait < 30 && !routeNames.length; wait++) {
    await sleep(1000);
    routeNames = await page.run(`return Array.from(document.querySelectorAll('#route-list li')).map(li => li.textContent.trim());`);
  }
  log('route:', routeNames.length, 'stations;', await page.run(`return document.getElementById('route-status').textContent;`));
  const typed = await page.run(`return [document.getElementById('origin').value, document.getElementById('destination').value];`);
  check(typed[0] === 'PATNA JN (PNBE)' && typed[1] === 'MUGHAL SARAI JN (MGS)', 'a typed code is shown with its station name once the route is built', typed.join(' / '));
  const place = code => routeNames.findIndex(name => name.endsWith(`(${code})`));
  for (const [before, code, after] of [['DNR', 'NEO', 'SDE'], ['JMIR', 'ARA', 'JGWL'], ['KCA', 'EOCM', 'MGS']])
    check(place(before) >= 0 && place(before) < place(code) && place(code) < place(after), `the Patna to Mughal Sarai route has ${code} in its place`);
  await page.run(`document.getElementById('route-list').scrollIntoView({block: 'start'});`);
  await sleep(800);
  shot('route');
  await page.run(`document.getElementById('route-clear').click(); window.scrollTo(0, 0);`);

  // ---- A journey: started in the app, it must be recorded natively, with the screen off as well.
  await page.run(`document.getElementById('start').click();`);
  await sleep(4000);
  for (let i = 0; i < 8; i++) { setFix(25.548889 + i * 0.0003, 84.662596); await sleep(1500); }
  const started = await page.run(`
    return {watcher: nativeWatcher && nativeWatcher.id, browserWatch: watchId, tracking, status: document.getElementById('status').textContent,
      now: document.getElementById('now').textContent, last: last && last.t, lastFixTime, native: await fixBuffer?.status?.()};`);
  log('journey started:', JSON.stringify(started));
  check(started.tracking && started.watcher != null, 'starting a journey starts the native location watcher', String(started.watcher));
  check(started.native && started.native.fixes > 0, 'the native side receives location fixes', JSON.stringify(started.native));
  check(started.last != null, 'the page receives the fixes', started.status);
  const services = quiet(() => shell(`dumpsys activity services ${PACKAGE}`));
  check(/isForeground=true/.test(services), 'the location service runs in the foreground (what keeps Android from stopping it)');
  const notifications = quiet(() => shell('dumpsys notification --noredact'));
  check(notifications.includes(PACKAGE), 'the tracking notification is shown');
  shot('journey');

  await page.run(`window.e2eMark = 'before the screen went off';`);
  const pidBefore = shell(`pidof ${PACKAGE}`);
  quiet(() => adb('logcat', '-b', 'all', '-c'));
  const offStart = deviceTime();
  shell('input keyevent KEYCODE_SLEEP');
  for (let i = 0; i < 20; i++) { setFix(25.5513 + i * 0.0003, 84.662596); await sleep(2000); }
  const power = quiet(() => shell('dumpsys power'));
  log('screen while off:', (power.match(/mWakefulness=\w+/) || ['?'])[0]);
  const offEnd = deviceTime();
  shell('input keyevent KEYCODE_WAKEUP');
  quiet(() => shell('wm dismiss-keyguard'));
  quiet(() => shell('input keyevent 82'));
  await sleep(4000);
  // The test's own connection to the page may not survive the screen going off; the app's state is what is
  // checked, so the app is brought to the front if it is not, and the page is opened afresh.
  if (!inFront()) { log('the app was not in front after the screen came on; bringing it back'); launch(); }
  page.close();
  page = await openPage();
  await sleep(5000);
  const samePage = await page.run(`return window.e2eMark === 'before the screen went off';`);
  const pidAfter = shell(`pidof ${PACKAGE}`);
  log('the same page as before the screen went off:', samePage, '| process', pidBefore, '->', pidAfter);
  if (!samePage) log('what Android did meanwhile:\n' + lifeEvents());
  const woke = await page.run(`
    const fixes = (await fixBuffer.drain({after: 0})).fixes.map(f => f.time);
    return {fixes, lastFixTime, last: last && last.t, visible: document.visibilityState, status: document.getElementById('status').textContent,
      now: document.getElementById('now').textContent, native: await fixBuffer.status()};`);
  const during = woke.fixes.filter(time => time > offStart + 3000 && time < offEnd - 1000);
  log('after the screen was off for', Math.round((offEnd - offStart) / 1000), 's:', during.length, 'fixes of that time;',
    JSON.stringify({...woke, fixes: woke.fixes.length}));
  check(/Asleep|Dozing/.test(power), 'the screen really was off');
  check(during.length >= 8, 'fixes kept arriving natively while the screen was off', `${during.length} in ${Math.round((offEnd - offStart) / 1000)} s`);
  check(woke.lastFixTime >= offEnd - 15000, 'the page caught up with the fixes it missed', `${woke.lastFixTime} against ${offEnd}`);
  shot('journey-after-screen-off');

  // The native side gives the page only the fixes it has not had: those after the time it asks for, in time
  // order, each once. (A time in milliseconds was once read as 0 there, so every 5 seconds the whole journey's
  // fixes were sent again.)
  const order = await page.run(`
    const all = (await fixBuffer.drain({after: 0})).fixes.map(f => f.time);
    const cut = all[Math.max(0, all.length - 5)];
    const later = (await fixBuffer.drain({after: cut})).fixes.map(f => f.time);
    return {count: all.length, ordered: all.every((t, i) => !i || t > all[i - 1]), cut, later};`);
  log('native fixes:', JSON.stringify(order));
  check(order.count > 5 && order.ordered, 'the native fixes are kept in time order, each once', `${order.count} fixes`);
  check(order.later.length > 0 && order.later.length < order.count && order.later.every(t => t > order.cut),
    'the native side gives only the fixes after the time asked for', `${order.later.length} of ${order.count}`);

  await page.run(`document.getElementById('stop').click();`);
  await sleep(2500);
  const stopped = await page.run(`return {watcher: nativeWatcher, tracking};`);
  check(!stopped.tracking && stopped.watcher == null, 'Stop ends the native watcher');
  check(!/isForeground=true/.test(quiet(() => shell(`dumpsys activity services ${PACKAGE}`))), 'Stop takes the tracking notification away');
  page.close();

  // ---- The same clock at the phone's ordinary font size.
  shell(`am force-stop ${PACKAGE}`);
  shell('settings put system font_scale 1.0');
  await sleep(1500);
  launch();
  page = await openPage();
  await clockCheck(page, 'normal-font');
  page.close();
}

main().catch(error => {
  failures.push('the run broke off: ' + (error.stack || error.message));
}).finally(() => {
  if (failures.length) {
    console.log('\n--- app log');
    console.log(quiet(() => adb('logcat', '-d', '-t', '400', '-s', 'SathiTracking:V', 'SathiUpdate:V', 'Capacitor:V', 'Capacitor/Console:V', 'Capacitor/Plugin:V', 'AndroidRuntime:E', 'chromium:W')));
    console.log(`\n${failures.length} FAILED:`);
    for (const failure of failures) console.log(' - ' + failure);
    process.exit(1);
  }
  console.log('\nAll app checks passed.');
  process.exit(0);
});
