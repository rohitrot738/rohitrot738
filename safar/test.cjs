const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(fetch, saved) {
  const elements = {};
  function element() {
    return {
      textContent: '', value: 'auto', children: [],
      append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; this.textContent = ''; },
      click() {}
    };
  }
  const document = {getElementById(id) { return elements[id] ||= element(); }, createElement: element};
  const store = new Map(saved || []);
  const localStorage = {getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k)};
  const watches = [];
  const geolocation = {
    watchPosition(success, error, options) { watches.push({success, error, options}); return watches.length; },
    clearWatch(id) { watches[id - 1].cleared = true; }
  };
  const context = {document, localStorage, navigator: {geolocation}, fetch, AbortController, setTimeout, clearTimeout,
    console, Date, Math, Number, JSON, Blob, URL, confirm: () => true};
  vm.runInNewContext(script, context);
  return {elements, store, watches};
}

const fix = (lat, t, speed = 10, accuracy = 10) =>
  ({coords: {latitude: lat, longitude: 77, accuracy, speed}, timestamp: t});
const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  let requests = 0;
  const app = setup(async url => {
    assert.equal(url, 'stations.json');
    requests++;
    return {ok: true, json: async () => [['TST', 'Test Station', 28, 77]]};
  });
  app.elements.start.onclick();
  app.watches[0].success(fix(28, 100000));
  await flush();
  assert.equal(requests, 1);
  assert.match(app.elements.now.textContent, /Test Station/);
  assert.match(app.elements['data-status'].textContent, /taiyar/);
  app.watches[0].success(fix(28.01, 160000));
  assert.equal(JSON.parse(app.store.get('trainlog'))[0].name, 'Test Station');
  assert.equal(JSON.parse(app.store.get('trainlog'))[0].type, 'pass');

  const halt = setup(async () => ({ok: true, json: async () => [['HLT', 'Halt', 28, 77]]}));
  halt.elements.start.onclick();
  halt.watches[0].success(fix(28, 100000, 0));
  await flush();
  halt.watches[0].success(fix(28, 140000, 0));
  halt.watches[0].success(fix(28, 145000, 10));
  halt.watches[0].success(fix(28.01, 160000, 10));
  const event = JSON.parse(halt.store.get('trainlog'))[0];
  assert.equal(event.type, 'halt');
  assert.equal(event.arr, 100000);
  assert.equal(event.dep, 145000);

  const geo = setup(async () => { throw new Error('offline'); });
  geo.elements.start.onclick();
  geo.watches[0].error({code: 3});
  assert.equal(geo.watches[0].cleared, true);
  assert.equal(geo.watches[1].options.enableHighAccuracy, false);
  geo.watches[1].error({code: 1});
  assert.match(geo.elements.status.textContent, /permission/);
  assert.equal(geo.watches[1].cleared, true);

  const noData = setup(async () => { throw new Error('offline'); });
  noData.elements.start.onclick();
  noData.watches[0].success(fix(28, 100000));
  await flush();
  assert.match(noData.elements['data-status'].textContent, /Internet check/);
  assert.equal(noData.store.has('trainlog'), false);

  const inaccurate = setup(async () => ({ok: true, json: async () => [['TST', 'Test Station', 28, 77]]}));
  inaccurate.elements.start.onclick();
  inaccurate.watches[0].success(fix(28, 100000, 10, 1000));
  await flush();
  assert.match(inaccurate.elements.status.textContent, /Accuracy kam/);
  assert.match(inaccurate.elements.now.textContent, /Test Station/);
  assert.equal(inaccurate.store.has('trainlog'), false);

  const offline = setup(async () => { throw new Error('offline cache should avoid fetch'); }, app.store);
  offline.elements.start.onclick();
  offline.watches[0].success(fix(28, 100000));
  assert.match(offline.elements.now.textContent, /Test Station/);
  assert.match(offline.elements['data-status'].textContent, /Saved station list/);

  const database = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'stations.json'), 'utf8'));
  assert.equal(database.length, 8702);
  const delhi = database.find(row => row[0] === 'NDLS');
  assert.equal(delhi[1], 'NEW DELHI');
  const real = setup(async () => ({ok: true, json: async () => database}));
  await flush();
  real.elements.start.onclick();
  real.watches[0].success({coords: {latitude: delhi[2], longitude: delhi[3], accuracy: 10, speed: 10}, timestamp: 100000});
  assert.match(real.elements.now.textContent, /NEW DELHI/);
  console.log('Safar tracker checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
