#!/usr/bin/env node
// Runs the debug build of the app on an Android emulator and checks, from inside its page, the things that only
// exist on a phone and that no test on a computer can see: that the page reaches the native side at all, that the
// full-screen clock hides the phone's bars and fills the screen whatever font size the phone is set to, that its
// sizes can be changed by touch from its gear, and that a journey goes on being recorded natively with the screen off.
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
// The app's connections to other apps' content providers, as Android lists them ("- <provider>-><client> sS/N uU/N
// <age>"). A stable one (s1 and up) ties the app's life to the provider's process: when that dies, Android ends the
// app as well ("depends on provider ... in dying proc"). It ended the app mid-journey on the emulator once, through
// Google Play services' font provider, whose process died.
function providerLinks() {
  return quiet(() => shell(`dumpsys activity processes ${PACKAGE}`)).split('\n').map(line => line.trim())
    .filter(line => /^- \S+->\d+:/.test(line));
}
// The files the app's process has open that are not its own (a font from Play services, say), to tell who holds a
// provider connection: a file opened through a provider holds it while it is open.
function foreignFiles() {
  const pid = shell(`pidof ${PACKAGE}`).split(/\s+/)[0];
  const fds = quiet(() => shell(`run-as ${PACKAGE} ls -l /proc/${pid}/fd`)).split('\n')
    .map(line => line.replace(/^.* (\d+) -> /, '$1 -> ')).filter(line => /-> \/(data|storage|mnt)\//.test(line) && !line.includes(`/${PACKAGE}/`) && !line.includes('/app/'));
  const maps = [...new Set(quiet(() => shell(`run-as ${PACKAGE} cat /proc/${pid}/maps`)).split('\n')
    .map(line => line.trim().split(/\s+/).slice(5).join(' ')).filter(path => /font|\.ttf|\.otf|gms/i.test(path) && !path.startsWith('/system/')))];
  return {fds, maps};
}
// Waits until the app holds no stable connection to a Play services provider, for up to "within" milliseconds.
async function untilUntied(when, within) {
  const from = Date.now();
  let tied = [];
  do {
    tied = providerLinks().filter(line => /com\.google\.android\.gms/.test(line.split('->')[0]) && / s[1-9]\d*\//.test(line));
    if (!tied.length) break;
    await sleep(2000);
  } while (Date.now() - from < within);
  log(`${when}: tied to Play services for ${Math.round((Date.now() - from) / 1000)} s more`, tied.join(' | '));
  check(!tied.length, `${when}: the app's life is not tied to a Google Play services provider for long`, tied.join(' | '));
}
function checkProviderLinks(when) {
  const links = providerLinks();
  log(`provider connections (${when}):`, links.join(' | ') || '(none)');
  const tied = links.filter(line => /com\.google\.android\.gms/.test(line.split('->')[0]) && / s[1-9]\d*\//.test(line));
  if (tied.length) log('files open that are not the app\'s own:', JSON.stringify(foreignFiles()));
  check(!tied.length, `${when}: the app's life is not tied to a Google Play services provider`, tied.join(' | '));
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

// A finger on the page: a tap on an element's middle, or a slide along the sizes slider from one share of it to
// another (the slider lies across the clock, so down the screen while the clock is turned).
async function tap(page, selector) {
  const [x, y] = await page.run(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];`);
  await page.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
  await page.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await sleep(400);
}
async function slide(page, from, to) {
  const [left, top, width, height, turned] = await page.run(`const r = document.getElementById('size-track').getBoundingClientRect();
    return [r.left, r.top, r.width, r.height, document.body.className.includes('turned')];`);
  const at = share => turned ? {x: left + width / 2, y: top + share * height} : {x: left + share * width, y: top + height / 2};
  await page.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [at(from)]});
  for (let step = 1; step <= 10; step++) {
    await page.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [at(from + (to - from) * step / 10)]});
    await sleep(16);
  }
  await page.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
}
// A screenshot once the emulator's screen has caught up: it draws in software, and a frame can lag a second behind.
async function settledShot(name) { await sleep(1200); shot(name); }
// The clock's parts as they stand, with the sizes bar.
const SIZES = CLOCK.replace(/return \{/, `const own = id => box(id).map(Math.round);
  return {open: !document.getElementById('clock-sizes').hidden, part: sizePart, mode: clockSizes.mode, saved: localStorage.getItem('safar-clock-sizes'),
    value: document.getElementById('size-value').textContent, gear: own('clock-edit'), bar: own('clock-sizes'),
    dateFont: parseFloat(document.getElementById('clock-date').style.fontSize),`);
// The clock's parts that must not cover one another, the time by its digits alone (see clockCheck).
function clearOfEachOther(clock) {
  const ink = [...clock.hm];
  if (clock.inner[1] > clock.inner[0]) ink[2] -= clock.blank; else ink[1] += clock.blank;
  const parts = {time: ink, dial: clock.dial, date: clock.date, exit: clock.exit, gear: clock.gear};
  const names = Object.keys(parts), touching = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
    if (overlap(parts[names[i]], parts[names[j]])) touching.push(`${names[i]} ${JSON.stringify(parts[names[i]].map(Math.round))} / ${names[j]} ${JSON.stringify(parts[names[j]].map(Math.round))}`);
  return touching;
}

// The sizes of the full-screen clock, worked as a finger would: the gear opens the bar, a part is picked and slid
// larger, Auto makes room for a larger dial, the sizes stay after leaving the clock, Custom keeps each part's own
// size, and "Pehle jaisa" brings the first layout back.
async function clockSizesCheck(page) {
  await page.run(`localStorage.removeItem('safar-clock-sizes'); clockSizes.mode = 'auto';
    for (const mode of ['auto', 'custom']) for (const part of CLOCK_PARTS) clockSizes[mode][part] = 1;
    document.getElementById('speed').textContent = '105';`);
  await tap(page, '#clock-full');
  await sleep(2500);
  const plain = await page.run(SIZES);
  log('sizes, plain clock:', JSON.stringify(plain));
  const [width, height] = plain.inner;
  check(/clockmode/.test(plain.body) && !plain.open, 'sizes: the full-screen clock opens with the sizes bar closed');
  check(plain.gear[2] - plain.gear[0] >= 24 && plain.gear[3] - plain.gear[1] >= 24 && plain.gear[0] >= 0 && plain.gear[2] <= width && plain.gear[3] <= height,
    'sizes: the gear is on the screen, large enough to tap', JSON.stringify(plain.gear));
  check(!clearOfEachOther(plain).length, 'sizes: the gear, EXIT, the date, the time and the dial do not cover one another', clearOfEachOther(plain).join('; '));
  await tap(page, '#clock-time');
  check(!(await page.run(SIZES)).open, 'sizes: a tap on the clock changes nothing until the gear is pressed');

  await tap(page, '#clock-edit');
  const opened = await page.run(SIZES);
  check(opened.open && opened.part === 'time' && opened.mode === 'auto', 'sizes: the gear opens the bar, on the time, in Auto', JSON.stringify([opened.open, opened.part, opened.mode]));
  await settledShot('clock-sizes-bar');
  await tap(page, '#size-dial');
  await slide(page, 0.3, 0.8);
  await sleep(150);
  await tap(page, '#size-done');   // straight after sliding, as a hand would
  const larger = await page.run(SIZES);
  log('sizes, Auto with a larger dial:', JSON.stringify(larger));
  await settledShot('clock-sizes-auto-larger-dial');
  const dialOf = clock => clock.dial[2] - clock.dial[0];
  check(dialOf(larger) > dialOf(plain) + 40, 'sizes: sliding makes the dial larger', `${dialOf(plain)} -> ${dialOf(larger)} px, ${larger.value}`);
  check(!larger.open, 'sizes: "Ho gaya" right after sliding closes the bar');
  check(larger.dateFont < plain.dateFont, 'sizes: in Auto the date gives the larger dial room', `${plain.dateFont} -> ${larger.dateFont}`);
  check(!clearOfEachOther(larger).length, 'sizes: in Auto nothing covers anything with the larger dial', clearOfEachOther(larger).join('; '));

  await tap(page, '#clock-full');
  await sleep(2000);
  await tap(page, '#clock-full');
  await sleep(2500);
  const back = await page.run(SIZES);
  check(dialOf(back) === dialOf(larger) && JSON.parse(back.saved || '{}').auto?.dial > 1, 'sizes: the sizes stay after leaving the clock and coming back',
    `${dialOf(larger)} -> ${dialOf(back)} px; kept: ${back.saved}`);

  await tap(page, '#clock-edit');
  await tap(page, '#size-custom');
  const custom = await page.run(SIZES);
  check(custom.mode === 'custom' && dialOf(custom) === dialOf(plain) && custom.font === plain.font,
    'sizes: Custom starts from the first layout, with sizes of its own', `${dialOf(custom)} px, ${custom.font}`);
  await tap(page, '#size-dial');
  for (let i = 0; i < 4; i++) await tap(page, '#size-up');
  const own = await page.run(SIZES);
  log('sizes, Custom with a larger dial:', JSON.stringify(own));
  await settledShot('clock-sizes-custom-larger-dial');
  check(own.value === '120%' && dialOf(own) > dialOf(plain) + 30, 'sizes: + makes the dial larger in steps', `${own.value}, ${dialOf(own)} px`);
  check(own.font === plain.font && own.dateFont === plain.dateFont, 'sizes: in Custom the time and the date keep their sizes when the dial grows',
    `${own.font} / ${own.dateFont} against ${plain.font} / ${plain.dateFont}`);

  await tap(page, '#size-reset');
  await tap(page, '#size-auto');
  await tap(page, '#size-reset');
  await tap(page, '#size-done');
  const reset = await page.run(SIZES);
  check(dialOf(reset) === dialOf(plain) && reset.font === plain.font && reset.dateFont === plain.dateFont && !reset.open,
    '"Pehle jaisa" brings back the first layout', `${dialOf(reset)} px, ${reset.font}, ${reset.dateFont}`);
  await tap(page, '#clock-full');
  await sleep(2000);
  check((await page.run(`return document.body.className;`)) === '', 'sizes: EXIT leaves the full-screen clock');
}

// Whether the built app still starts EmojiCompat (its manifest names the initializer), read with aapt2.
function emojiCompatInManifest() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !fs.existsSync(`${sdk}/build-tools`)) return 'no SDK found';
  const tools = fs.readdirSync(`${sdk}/build-tools`).sort().reverse().map(v => `${sdk}/build-tools/${v}/aapt2`).find(f => fs.existsSync(f));
  if (!tools) return 'no aapt2 found';
  const tree = quiet(() => execFileSync(tools, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], {encoding: 'utf8', maxBuffer: 64 << 20}));
  return tree.includes('EmojiCompatInitializer') ? 'yes' : tree.includes('InitializationProvider') ? 'no (start-up provider there without it)' : 'no';
}

async function main() {
  log('EmojiCompat started by the app:', emojiCompatInManifest());
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

  // When its page starts, the WebView fetches fonts (Google Sans and an emoji font) from Play services' font
  // provider, and its stable connection to the provider used to linger for minutes: Android then ends the app
  // whenever Play services' process dies, as it did here twice. The app has the leftovers collected; the connection
  // must be gone within 20 seconds of the page opening.
  log('fonts, page open:', providerLinks().join(' | ') || '(none)', JSON.stringify(foreignFiles()));
  await untilUntied('page open', 20000);

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

  checkProviderLinks('during the journey');
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

  // ---- The page's own process (the WebView's renderer) ends during the journey with the screen off, as Android
  // may end it then. The app must go on: the screen is made again, its page takes the journey up again, the fixes
  // of the time between reach it from the native list, and the old page's location watcher does not linger.
  await page.run(`window.e2eMark = 'before the page process ended';`);
  const pidBeforeCrash = shell(`pidof ${PACKAGE}`);
  quiet(() => adb('logcat', '-b', 'all', '-c'));
  const crashFrom = deviceTime();
  shell('input keyevent KEYCODE_SLEEP');
  for (let i = 0; i < 2; i++) { setFix(25.5573 + i * 0.0003, 84.662596); await sleep(2000); }
  const crashAnswer = page.send('Page.crash').then(() => 'answered', e => e.message);
  await sleep(1500);
  log('Page.crash with the screen off:', await Promise.race([crashAnswer, sleep(10).then(() => 'no answer yet')]));
  page.close();
  for (let i = 2; i < 17; i++) { setFix(25.5573 + i * 0.0003, 84.662596); await sleep(2000); }
  const crashTo = deviceTime();
  shell('input keyevent KEYCODE_WAKEUP');
  quiet(() => shell('wm dismiss-keyguard'));
  quiet(() => shell('input keyevent 82'));
  await sleep(4000);
  if (!inFront()) { log('the app was not in front after the screen came on; bringing it back'); launch(); }
  page = await openPage();
  await sleep(6000);
  const pidAfterCrash = shell(`pidof ${PACKAGE}`);
  const recovered = await page.run(`
    return {mark: window.e2eMark || null, tracking, watcher: nativeWatcher && nativeWatcher.id, lastFixTime,
      status: document.getElementById('status').textContent, native: await fixBuffer?.status?.(),
      times: fixBuffer ? (await fixBuffer.drain({after: 0})).fixes.map(f => f.time) : []};`);
  log("after the page's process ended:", JSON.stringify({...recovered, times: recovered.times.length}), '| process', pidBeforeCrash, '->', pidAfterCrash);
  log('what Android did meanwhile:\n' + lifeEvents());
  const meanwhile = recovered.times.filter(time => time > crashFrom + 4000 && time < crashTo - 1000);
  check(pidAfterCrash === pidBeforeCrash, "the app goes on when the page's process ends", `${pidBeforeCrash} -> ${pidAfterCrash}`);
  check(recovered.mark == null && recovered.tracking && recovered.watcher != null, 'the page is made again and takes the journey up again', recovered.status);
  check(meanwhile.length >= 5, 'fixes were kept natively while the page was gone', `${meanwhile.length} in ${Math.round((crashTo - crashFrom) / 1000)} s`);
  check(recovered.lastFixTime >= crashTo - 15000, 'the new page has the fixes of the time between', `${recovered.lastFixTime} against ${crashTo}`);
  shot('journey-after-page-process-ended');

  await untilUntied('after the page was made again', 20000);
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
  await clockSizesCheck(page);

  await untilUntied('a second start of the app', 20000);
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
