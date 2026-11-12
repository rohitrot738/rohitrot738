const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(fetch, saved, capacitor = null) {
  const elements = {};
  function element() {
    return {
      textContent: '', value: 'auto', children: [], style: {}, dataset: {},
      append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; this.textContent = ''; },
      click() {}
    };
  }
  const document = {getElementById(id) { return elements[id] ||= element(); }, createElement: element, body: elements.body = element()};
  const store = new Map(saved || []);
  const localStorage = {getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k)};
  const watches = [];
  const geolocation = {
    watchPosition(success, error, options) { watches.push({success, error, options}); return watches.length; },
    clearWatch(id) { watches[id - 1].cleared = true; }
  };
  const context = {document, localStorage, navigator: {geolocation}, window: {Capacitor: capacitor}, fetch, AbortController, setTimeout, clearTimeout, setInterval: (fn, ms) => { (elements.intervals ||= []).push({fn, ms}); elements.clockTick = fn; return 0; }, String,
    console, Date, Math, Number, JSON, Blob, URL, confirm: () => true};
  vm.runInNewContext(script, context);
  return {elements, store, watches};
}

// A route-list row is <li><label><input type=checkbox><span>name</span></label></li>.
const rowName = li => li.children[0].children[1].textContent;
const rowBox = li => li.children[0].children[0];
const fix = (lat, t, speed = 10, accuracy = 10) =>
  ({coords: {latitude: lat, longitude: 77, accuracy, speed}, timestamp: t});
const flush = () => new Promise(resolve => setImmediate(resolve));
const routeSummary = {
  station_seeds: 100, station_codes_with_candidate_route_edges: 90,
  station_catalog_records: 8702, candidate_station_route_edges: 80,
  osm_snapshot_timestamp: '2026-11-05T21:23:02Z',
  status: 'candidate paths only; no train timetable, train-specific route, or live train position'
};
const stationFetcher = (rows, osmRows = []) => async url => ({
  ok: true,
  json: async () => url === 'stations.json' ? rows
    : url === 'osm-stations.json' ? osmRows
    : routeSummary
});

(async () => {
  let requests = 0;
  const app = setup(async url => {
    if (url === 'stations.json') {
      requests++;
      return {ok: true, json: async () => [['TST', 'Test Station', 28, 77]]};
    }
    if (url === 'osm-stations.json') return {ok: true, json: async () => [['OSM:77', 'Mapped Test', 28.1, 77]]};
    if (url === 'osm-station-route-summary.json') return {ok: true, json: async () => routeSummary};
    throw new Error('unexpected URL ' + url);
  });
  app.elements.start.onclick();
  app.watches[0].success(fix(28, 100000));
  await flush();
  assert.equal(requests, 1);
  assert.equal(JSON.parse(app.store.get('safar-stations-v2')).osm.length, 1);
  assert.match(app.elements.now.textContent, /Test Station/);
  assert.match(app.elements['data-status'].textContent, /taiyar/);
  assert.equal(app.elements['data-status'].hidden, true);
  assert.doesNotMatch(html, /network-status|App updates dekhein|suffer-sathi-updates/);
  // The log's colours: amber for a halt, green for a pass. (A style rewrite once dropped these rules.)
  assert.match(html, /\.stop\{border-left:4px solid #f59e0b\}/);
  assert.match(html, /\.pass\{border-left:4px solid #22c55e\}/);
  app.watches[0].success(fix(28.01, 160000));
  assert.equal(JSON.parse(app.store.get('trainlog'))[0].name, 'Test Station');
  assert.equal(JSON.parse(app.store.get('trainlog'))[0].id, 'TST');
  assert.equal(JSON.parse(app.store.get('trainlog'))[0].source, 'DataMeet + project fallback');
  assert.equal(JSON.parse(app.store.get('trainlog'))[0].type, 'pass');

  const halt = setup(stationFetcher([['HLT', 'Halt', 28, 77]]));
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

  let nativeCallback, removedNativeWatcher = false;
  const nativeCapacitor = {
    isNativePlatform: () => true,
    registerPlugin: name => {
      if (name === 'SafarBuffer') return {drain: async () => ({fixes: []}), clear: async () => {}};
      assert.equal(name, 'BackgroundGeolocation');
      return {
        addWatcher: async (_options, callback) => { nativeCallback = callback; return 'native-watch'; },
        removeWatcher: async ({id}) => { assert.equal(id, 'native-watch'); removedNativeWatcher = true; }
      };
    }
  };
  const native = setup(stationFetcher([['NAT', 'Native Station', 28, 77]]), null, nativeCapacitor);
  native.elements.start.onclick();
  await flush();
  nativeCallback({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 100000}, null);
  await flush();
  nativeCallback({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 145000}, null);
  nativeCallback({latitude: 28.01, longitude: 77, accuracy: 10, speed: 10, time: 160000}, null);
  await flush(); // a fix the native list does not have is used after the list is read
  assert.equal(JSON.parse(native.store.get('trainlog'))[0].name, 'Native Station');
  native.elements.stop.onclick();
  await flush();
  assert.equal(removedNativeWatcher, true);

  // The app as it really is. Capacitor's registerPlugin is not on the page (the page is not built with Capacitor's
  // script); the native plugins are plain objects on Capacitor.Plugins, and a watcher's id comes back directly, not
  // as a promise. The page must reach them all the same: for a long time it asked only for registerPlugin and so
  // never used the native side at all.
  let appCallback, appRemoved = false, appBegun = 0;
  const appBars = [];
  const inApp = setup(stationFetcher([['NAT', 'Native Station', 28, 77]]), null, {
    isNativePlatform: () => true,
    Plugins: {
      BackgroundGeolocation: {
        addWatcher: (_options, callback) => { appCallback = callback; return '17'; },
        removeWatcher: async ({id}) => { assert.equal(id, '17'); appRemoved = true; }
      },
      SafarBuffer: {
        drain: async () => ({fixes: []}), begin: async () => { appBegun++; }, end: async () => {},
        status: async () => ({}), fullScreen: async ({on}) => { appBars.push(on); }
      }
    }
  });
  inApp.elements.start.onclick();
  await flush();
  assert.equal(appBegun, 1);
  assert.equal(inApp.watches.length, 0); // the browser's location, which stops with the screen, is not what runs
  appCallback({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 100000}, null);
  await flush();
  appCallback({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 145000}, null);
  appCallback({latitude: 28.01, longitude: 77, accuracy: 10, speed: 10, time: 160000}, null);
  await flush();
  assert.equal(JSON.parse(inApp.store.get('trainlog'))[0].name, 'Native Station');
  inApp.elements.stop.onclick();
  await flush();
  assert.equal(appRemoved, true);
  // The full-screen clock hides the phone's own bars through the native side, and brings them back.
  inApp.elements['clock-full'].onclick();
  inApp.elements['clock-full'].onclick();
  assert.deepEqual(appBars, [true, false]);

  // A slow first native fix adds browser location beside the native watcher, which alone works with the screen
  // off; it is not replaced, and its first fix takes over again.
  const realSetTimeout = global.setTimeout, timers = [];
  global.setTimeout = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
  let slowCallback, slowRemoved = false;
  const slow = setup(stationFetcher([['NAT', 'Native Station', 28, 77]]), null, {
    isNativePlatform: () => true,
    registerPlugin: () => ({
      addWatcher: async (_options, callback) => { slowCallback = callback; return 'slow-watch'; },
      removeWatcher: async () => { slowRemoved = true; }
    })
  });
  global.setTimeout = realSetTimeout;
  slow.elements.start.onclick();
  await flush();
  timers.find(timer => timer.ms === 20000).fn();
  assert.equal(slow.watches.length, 1);
  assert.equal(slowRemoved, false);
  slowCallback({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 100000}, null);
  assert.equal(slow.watches[0].cleared, true);
  assert.equal(slowRemoved, false);
  assert.match(slow.elements.status.textContent, /Location mil rahi hai/);
  assert.equal(JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'capacitor.config.json'), 'utf8')).android.useLegacyBridge, true);

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
  assert.equal(noData.elements['data-status'].hidden, false);
  assert.equal(noData.store.has('trainlog'), false);

  const inaccurate = setup(stationFetcher([['TST', 'Test Station', 28, 77]]));
  inaccurate.elements.start.onclick();
  inaccurate.watches[0].success(fix(28, 100000, 10, 1000));
  await flush();
  assert.match(inaccurate.elements.status.textContent, /Accuracy kam/);
  assert.match(inaccurate.elements.now.textContent, /Test Station/);
  assert.equal(inaccurate.store.has('trainlog'), false);

  // With no network the saved list carries on (the shipped list is still asked for, and fails).
  const offline = setup(async () => { throw new Error('offline'); }, app.store);
  offline.elements.start.onclick();
  offline.watches[0].success(fix(28, 100000));
  assert.match(offline.elements.now.textContent, /Test Station/);
  assert.match(offline.elements['data-status'].textContent, /Saved station list/);
  await flush();
  assert.match(offline.elements.now.textContent, /Test Station/);
  assert.match(offline.elements['data-status'].textContent, /Saved station list/);

  const legacyOffline = setup(async () => { throw new Error('offline'); }, [
    ['safar-stations-v1', JSON.stringify([['OLD', 'Cached Station', 28, 77]])]
  ]);
  legacyOffline.elements.start.onclick();
  legacyOffline.watches[0].success(fix(28, 100000));
  await flush();
  assert.match(legacyOffline.elements.now.textContent, /Cached Station/);
  assert.match(legacyOffline.elements['data-status'].textContent, /Saved station list available/);

  const database = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'stations.json'), 'utf8'));
  assert.equal(database.length, 8703);
  const delhi = database.find(row => row[0] === 'NDLS');
  assert.equal(delhi[1], 'NEW DELHI');
  const real = setup(stationFetcher(database));
  await flush();
  real.elements.start.onclick();
  real.watches[0].success({coords: {latitude: delhi[2], longitude: delhi[3], accuracy: 10, speed: 10}, timestamp: 100000});
  assert.match(real.elements.now.textContent, /NEW DELHI/);

  const edges = [['SEB', 'DOS', 100]];
  const routed = setup(async url => url === 'osm-station-routes.json'
    ? {ok: true, json: async () => ({schema_version: 1, stations_unreviewed: true, edges})}
    : stationFetcher(database)(url));
  await flush();
  routed.elements.origin.value = 'SEB';
  routed.elements.destination.value = 'DOS';
  await routed.elements['find-route'].onclick();
  // ADSR has no link of its own but lies on the line between the two, so the route takes it in.
  assert.match(routed.elements['route-status'].textContent, /Route bana: 3 stations/);
  assert.deepEqual(routed.elements['route-list'].children.map(rowName), ['SON NAGAR (SEB)', 'ADSR (ADSR)', 'DEHRI ON SONE (DOS)']);
  // Its tick taken off, it is not logged though the train passes right over it.
  const adsrBox = routed.elements['route-list'].children[1].children[0].children[0];
  adsrBox.checked = false;
  adsrBox.onchange();
  routed.elements.start.onclick();
  routed.watches[0].success({coords: {latitude: 24.9, longitude: 84.208, accuracy: 4, speed: 10}, timestamp: 100000});
  assert.match(routed.elements.next.textContent, /Sambhavit agla station: DEHRI ON SONE \(DOS\)/);
  assert.equal(routed.elements.speed.textContent, '36');
  routed.watches[0].success({coords: {latitude: 24.909345, longitude: 84.192214, accuracy: 4, speed: 10}, timestamp: 160000});
  routed.watches[0].success({coords: {latitude: 24.914895, longitude: 84.185434, accuracy: 4, speed: 10}, timestamp: 220000});
  assert.doesNotMatch(routed.store.get('trainlog') || '', /ADSR/);
  routed.watches[0].success({coords: {latitude: 25.5, longitude: 85, accuracy: 4, speed: 10}, timestamp: 280000});
  // Off the chosen route the tracker keeps going: the next station comes from the direction of travel.
  assert.match(routed.elements.next.textContent, /Agla station \(disha se anumaan\): .+ km/);
  await routed.elements['find-route'].onclick();
  assert.match(routed.elements['route-status'].textContent, /Stop dabayein/);

  const osmRoute = setup(async url => url === 'osm-station-routes.json'
    ? {
      ok: true,
      json: async () => ({
        schema_version: 1, stations_unreviewed: true, edges: [['OSM:77', 'OSM:78', 100]]
      })
    }
    : url === 'osm-stations.json'
      ? {ok: true, json: async () => [['OSM:77', 'OSM Alpha', 28, 77], ['OSM:78', 'OSM Beta', 29, 77]]}
      : stationFetcher([['PROJ', 'Project Station', 27, 77]])(url));
  await flush();
  osmRoute.elements.origin.value = 'OSM:77';
  osmRoute.elements.destination.value = 'OSM:78';
  await osmRoute.elements['find-route'].onclick();
  assert.match(osmRoute.elements['route-status'].textContent, /Route bana: 2 stations/);
  assert.deepEqual(osmRoute.elements['route-list'].children.map(rowName),
    ['OSM Alpha', 'OSM Beta']);

  osmRoute.elements.origin.dataset = {};
  osmRoute.elements.origin.value = 'alpha';
  osmRoute.elements.origin.oninput();
  const options = osmRoute.elements['origin-options'].children;
  assert.equal(options.length, 1);
  options[0].onclick();
  assert.equal(osmRoute.elements.origin.value, 'OSM Alpha');
  assert.equal(osmRoute.elements.origin.dataset.stationId, 'OSM:77');
  assert.equal(osmRoute.elements['origin-options'].children.length, 0);

  osmRoute.elements.start.onclick();
  assert.ok(osmRoute.store.get('safar-active'));
  const savedActive = osmRoute.store.get('safar-active');
  const resumed = setup(stationFetcher([['A', 'A', 28, 77]]),
    [['safar-active', savedActive], ['safar-stations-v2', JSON.stringify({catalog: [['A', 'A', 28, 77]], osm: [['OSM:77', 'OSM Alpha', 28, 77], ['OSM:78', 'OSM Beta', 29, 77]]})]]);
  assert.equal(resumed.watches.length, 1);
  osmRoute.elements.stop.onclick();
  assert.equal(osmRoute.store.get('safar-active'), undefined);

  // A station list saved by an older version must not hide the list this version ships: the new stations and the
  // links through them have to be there after an update.
  const updated = setup(async url => url === 'edges.json'
    ? {ok: true, json: async () => [['A','N',50],['N','B',50],['A','X',10],['X','Y',400],['Y','B',10]]}
    : url === 'osm-station-routes.json' ? {ok: true, json: async () => ({schema_version: 1, edges: []})}
    : stationFetcher([['A','A',28,77],['B','B',29,77],['X','X',28.1,78],['Y','Y',28.9,78],['N','New Cabin',28.5,77]])(url),
    [['safar-stations-v2', JSON.stringify({catalog: [['A','A',28,77],['B','B',29,77],['X','X',28.1,78],['Y','Y',28.9,78]], osm: []})]]);
  await flush();
  updated.elements.origin.value = 'A';
  updated.elements.destination.value = 'B';
  await updated.elements['find-route'].onclick();
  assert.deepEqual(updated.elements['route-list'].children.map(rowName), ['A (A)', 'New Cabin (N)', 'B (B)']);
  assert.equal(JSON.parse(updated.store.get('safar-stations-v2')).catalog.length, 5);

  const badRoute = setup(async url => url === 'osm-station-routes.json'
    ? {ok: true, json: async () => ({schema_version: 1, stations_unreviewed: true, edges: [['A','B',100]]})}
    : stationFetcher([['A','A',28,77],['B','B',29,77],['C','C',30,77]])(url));
  await flush();
  badRoute.elements.origin.value = 'A';
  badRoute.elements.destination.value = 'C';
  await badRoute.elements['find-route'].onclick();
  assert.match(badRoute.elements['route-status'].textContent, /rasta nahi mila/);

  // The bundled data: the stations from the bug report route to each other, with no link of their own in the
  // OSM graph (the OSM-only station joins its nearest linked neighbour), and step station by station.
  const read = name => JSON.parse(fs.readFileSync(require('path').join(__dirname, name), 'utf8'));
  const bundled = setup(async url => ({ok: true, json: async () => read(url)}));
  await flush();
  const pick = (input, list, text, label) => {
    bundled.elements[input].dataset = {};
    bundled.elements[input].value = text;
    bundled.elements[input].oninput();
    bundled.elements[list].children.find(option => option.textContent === label).onclick();
  };
  pick('origin', 'origin-options', 'Deen Dayal Upadhyaya', 'MUGHAL SARAI JN (MGS) — ab Deen Dayal Upadhyaya Jn (DDU)');
  pick('destination', 'destination-options', 'ALD', 'ALLAHABAD JN (ALD) — ab Prayagraj Jn (PRYJ)');
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /Route bana: \d+ stations, lagbhag 1\d\d km/);
  const names = bundled.elements['route-list'].children.map(rowName);
  assert.equal(names[0], 'MUGHAL SARAI JN (MGS)');
  assert.equal(names[names.length - 1], 'ALLAHABAD JN (ALD)');
  assert.ok(names.length > 10);

  pick('origin', 'origin-options', 'NDLS', 'NEW DELHI (NDLS)');
  pick('destination', 'destination-options', 'HWH', 'HOWRAH JN (HWH)');
  await bundled.elements['find-route'].onclick();
  assert.ok(bundled.elements['route-list'].children.length > 150);

  // A code comes first even when many names contain it, and a renamed station answers to its new code.
  const firstOption = text => {
    bundled.elements.origin.dataset = {};
    bundled.elements.origin.value = text;
    bundled.elements.origin.oninput();
    return bundled.elements['origin-options'].children[0].textContent;
  };
  for (const [code, label] of [['MB', 'MORADABAD (MB)'], ['HW', 'HARIDWAR JN (HW)'], ['ara', 'ARA (ARA)']])
    assert.equal(firstOption(code), label);
  assert.match(firstOption('DDU'), /^MUGHAL SARAI JN \(MGS\) — ab Deen Dayal Upadhyaya Jn \(DDU\)$/);
  assert.match(firstOption('PRYJ'), /^ALLAHABAD JN \(ALD\)/);
  assert.match(firstOption('prayagraj jn'), /^ALLAHABAD JN \(ALD\)/);
  bundled.elements.origin.dataset = {};
  bundled.elements.origin.value = 'DDU';
  bundled.elements.destination.dataset = {};
  bundled.elements.destination.value = 'PRYJ';
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /Route bana/);
  assert.doesNotMatch(html, /RailTrack|railtrack/);

  // A stop between stations is logged with its times once the train moves on; standing before the journey is not.
  const outer = setup(stationFetcher([['HLT', 'Halt', 28, 77]]));
  outer.elements.start.onclick();
  outer.watches[0].success(fix(28.05, 100000, 0));
  await flush();
  outer.watches[0].success(fix(28.05, 160000, 0));
  outer.watches[0].success(fix(28.055, 170000, 10));
  assert.equal(outer.store.has('trainlog'), false);
  outer.watches[0].success(fix(28.06, 200000, 0));
  outer.watches[0].success(fix(28.06, 260000, 0));
  assert.match(outer.elements['live-stop'].textContent, /^Abhi ruki hai: Raste mein \(Halt se 6\.\d\d km\) — .+ se \(1 min\)$/);
  assert.equal(outer.elements['live-stop'].hidden, false);
  outer.watches[0].success(fix(28.061, 270000, 10));
  const outerLog = JSON.parse(outer.store.get('trainlog'));
  assert.equal(outerLog.length, 1);
  assert.match(outerLog[0].name, /^Raste mein \(Halt se 6\.\d\d km\)$/);
  assert.deepEqual([outerLog[0].type, outerLog[0].arr, outerLog[0].dep], ['halt', 200000, 270000]);
  outer.watches[0].success(fix(28.07, 300000, 0));
  outer.watches[0].success(fix(28.07, 310000, 10));
  assert.equal(JSON.parse(outer.store.get('trainlog')).length, 1);

  // Son Nagar Flyover Cabin (FOCS) is found by name and code, and a route down the Garhwa Road line passes it.
  assert.equal(firstOption('FOCS'), 'SON NAGAR FLYOVER CABIN (FOCS)');
  assert.equal(firstOption('son nagar fly'), 'SON NAGAR FLYOVER CABIN (FOCS)');
  pick('origin', 'origin-options', 'SEB', 'SON NAGAR (SEB)');
  pick('destination', 'destination-options', 'ANH', 'ANKORAH AKORHA (ANH)');
  await bundled.elements['find-route'].onclick();
  assert.deepEqual(bundled.elements['route-list'].children.map(rowName),
    ['SON NAGAR (SEB)', 'SON NAGAR FLYOVER CABIN (FOCS)', 'BAGAHABISHUNPUR (BCJ)', 'ANKORAH AKORHA (ANH)']);

  // Via: the shortest DDU -> Prayagraj route runs through Varanasi; a via station takes it along the Mirzapur line.
  const routeNames = () => bundled.elements['route-list'].children.map(rowName);
  const pickVia = (i, text, label) => {
    bundled.elements['via-' + i].dataset = {};
    bundled.elements['via-' + i].value = text;
    bundled.elements['via-' + i].oninput();
    bundled.elements[`via-${i}-options`].children.find(option => option.textContent === label).onclick();
  };
  pick('origin', 'origin-options', 'DDU', 'MUGHAL SARAI JN (MGS) — ab Deen Dayal Upadhyaya Jn (DDU)');
  pick('destination', 'destination-options', 'ALD', 'ALLAHABAD JN (ALD) — ab Prayagraj Jn (PRYJ)');
  await bundled.elements['find-route'].onclick();
  assert.ok(routeNames().includes('VARANASI JN (BSB)'));
  assert.ok(!routeNames().includes('MIRZAPUR (MZP)'));
  bundled.elements['add-via'].onclick();
  assert.equal(bundled.elements['via-row-1'].hidden, false);
  pickVia(1, 'MZP', 'MIRZAPUR (MZP)');
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /^Route bana \(via MIRZAPUR\): \d+ stations/);
  const viaRoute = routeNames();
  assert.equal(viaRoute[0], 'MUGHAL SARAI JN (MGS)');
  assert.equal(viaRoute[viaRoute.length - 1], 'ALLAHABAD JN (ALD)');
  assert.ok(viaRoute.includes('MIRZAPUR (MZP)') && !viaRoute.includes('VARANASI JN (BSB)'));
  assert.equal(viaRoute.filter(name => name === 'MIRZAPUR (MZP)').length, 1);
  // A via box with text that is no station stops the route; an empty one is skipped.
  bundled.elements['via-1'].dataset = {};
  bundled.elements['via-1'].value = 'zzzz';
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /Via station 1 nahi mila/);
  bundled.elements['via-1'].value = '';
  await bundled.elements['find-route'].onclick();
  assert.ok(routeNames().includes('VARANASI JN (BSB)'));

  // Only a code typed, not picked from the list: after the route is built the boxes show the stations that were
  // found, by name and code.
  for (const [id, code] of [['origin', 'ddu'], ['via-1', 'mzp'], ['destination', 'ald']]) {
    bundled.elements[id].dataset = {};
    bundled.elements[id].value = code;
  }
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /^Route bana \(via MIRZAPUR\)/);
  assert.deepEqual(['origin', 'via-1', 'destination'].map(id => bundled.elements[id].value),
    ['MUGHAL SARAI JN (MGS)', 'MIRZAPUR (MZP)', 'ALLAHABAD JN (ALD)']);
  assert.deepEqual(JSON.parse(bundled.store.get('safar-route')).origin, {value: 'MUGHAL SARAI JN (MGS)', id: 'MGS'});
  // Suggestions left open under a box are put away once the route is built.
  bundled.elements.destination.value = 'ald';
  bundled.elements.destination.oninput();
  assert.ok(bundled.elements['destination-options'].children.length > 0);
  await bundled.elements['find-route'].onclick();
  assert.equal(bundled.elements['destination-options'].children.length, 0);
  assert.equal(bundled.elements.destination.value, 'ALLAHABAD JN (ALD)');
  // A new start station begins another journey: the via boxes are emptied and put away, and the next route has
  // no via in it.
  pick('origin', 'origin-options', 'DDU', 'MUGHAL SARAI JN (MGS) — ab Deen Dayal Upadhyaya Jn (DDU)');
  assert.equal(bundled.elements['via-1'].value, '');
  assert.equal(bundled.elements['via-row-1'].hidden, true);
  assert.equal(bundled.elements['add-via'].hidden, false);
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /^Route bana: \d+ stations/);
  assert.ok(routeNames().includes('VARANASI JN (BSB)') && !routeNames().includes('MIRZAPUR (MZP)'));
  // The first via box comes back empty when asked for again.
  bundled.elements['add-via'].onclick();
  assert.equal(bundled.elements['via-row-1'].hidden, false);
  assert.equal(bundled.elements['via-1'].value, '');

  // A link that passes stations by: the route puts them back. North is known to the timetable between Alpha and
  // Beta, which an OSM link joins directly; Halt has no link at all but lies on the line; Twin is the same place
  // under a second code; Aside is too far off the line, and Loop is linked but lies a long way round.
  const passedStations = stationFetcher([['A', 'Alpha', 28, 77], ['N', 'North', 28.05, 77.002], ['B', 'Beta', 28.1, 77],
    ['H', 'Halt', 28.13, 77.0005], ['T', 'Twin', 28.1301, 77.0005], ['S', 'Aside', 28.15, 77.02], ['L', 'Loop', 28.15, 77.08],
    ['C', 'Gamma', 28.2, 77]]);
  const passed = setup(async url => url === 'edges.json'
    ? {ok: true, json: async () => [['A', 'N', 5.57], ['N', 'B', 5.57], ['B', 'C', 11.12], ['B', 'L', 9.6], ['L', 'C', 9.6]]}
    : url === 'osm-station-routes.json'
      ? {ok: true, json: async () => ({schema_version: 1, edges: [['A', 'B', 11100]]})}
      : passedStations(url));
  await flush();
  passed.elements.origin.value = 'A';
  passed.elements.destination.value = 'C';
  await passed.elements['find-route'].onclick();
  assert.deepEqual(passed.elements['route-list'].children.map(rowName),
    ['Alpha (A)', 'North (N)', 'Beta (B)', 'Halt (H)', 'Gamma (C)']);

  // The same on the real data: Patna to Mughal Sarai goes by Neora, Ara and the cabins before Mughal Sarai, which
  // the shortest links pass by.
  const readJson = name => JSON.parse(fs.readFileSync(require('path').join(__dirname, name), 'utf8'));
  const realFiles = {'stations.json': database, 'osm-stations.json': readJson('osm-stations.json'),
    'edges.json': readJson('edges.json'), 'osm-station-routes.json': readJson('osm-station-routes.json')};
  const patna = setup(async url => ({ok: url in realFiles, json: async () => realFiles[url]}));
  await flush();
  patna.elements.origin.value = 'PNBE';
  patna.elements.destination.value = 'MGS';
  await patna.elements['find-route'].onclick();
  const patnaCodes = patna.elements['route-list'].children.map(rowName).map(name => name.match(/\(([^)]+)\)$/)?.[1]);
  const place = code => patnaCodes.indexOf(code);
  for (const [before, code, after] of [['DNR', 'NEO', 'SDE'], ['JMIR', 'ARA', 'JGWL'], ['KCA', 'EOCM', 'MGS']]) {
    assert.ok(place(before) >= 0 && place(before) < place(code) && place(code) < place(after),
      `${code} is missing between ${before} and ${after}`);
  }
  assert.equal(new Set(patnaCodes).size, patnaCodes.length);

  // Choosing which stations are logged: an unticked route station is skipped, a ticked one is logged, and a
  // station the route missed can be added at its place.
  // Extra stands by the line but belongs to a side line of its own (its link to Side), so the route does not take
  // it in by itself.
  const chosenStations = stationFetcher([['A', 'Alpha', 28, 77], ['B', 'Beta', 28.1, 77], ['C', 'Gamma', 28.2, 77],
    ['D', 'Delta', 28.3, 77], ['X', 'Extra', 28.15, 77.001], ['Y', 'Side', 28.15, 77.06], ['FAR', 'Far Away', 20, 70]]);
  const chosen = setup(async url => url === 'edges.json'
    ? {ok: true, json: async () => [['A', 'B', 11], ['B', 'C', 11], ['C', 'D', 11], ['X', 'Y', 6]]} : chosenStations(url));
  await flush();
  chosen.elements.origin.value = 'A';
  chosen.elements.destination.value = 'D';
  await chosen.elements['find-route'].onclick();
  const rows = () => chosen.elements['route-list'].children;
  assert.deepEqual(rows().map(rowName), ['Alpha (A)', 'Beta (B)', 'Gamma (C)', 'Delta (D)']);
  assert.match(chosen.elements['route-choice'].textContent, /^4 \/ 4 station/);
  rowBox(rows()[1]).checked = false;
  rowBox(rows()[1]).onchange();
  assert.match(chosen.elements['route-choice'].textContent, /^3 \/ 4 station/);
  chosen.elements['add-station'].value = 'FAR';
  chosen.elements['add-station-btn'].onclick();
  assert.match(chosen.elements['add-station-status'].textContent, /door hai; nahi joda/);
  chosen.elements['add-station'].value = 'X';
  chosen.elements['add-station-btn'].onclick();
  assert.deepEqual(rows().map(rowName), ['Alpha (A)', 'Beta (B)', 'Extra (X)', 'Gamma (C)', 'Delta (D)']);
  assert.deepEqual(rows().map(li => rowBox(li).checked), [true, false, true, true, true]);
  chosen.elements.start.onclick();
  const run = chosen.watches[chosen.watches.length - 1];
  for (let i = 0; i <= 80; i++) run.success(fix(27.98 + i * 0.0045, 100000 + i * 10000, 30));
  assert.deepEqual(JSON.parse(chosen.store.get('trainlog')).map(entry => entry.id), ['A', 'X', 'C', 'D']);
  // The route and its ticks are kept: a fresh start of the app on the same phone shows them again.
  chosen.elements.stop.onclick();
  chosen.elements['route-save'].onclick();
  assert.match(chosen.elements['route-status'].textContent, /^Save ho gaya: Alpha se Delta, 4 \/ 5 station/);
  assert.equal(chosen.elements['route-details'].open, false);
  const reopened = setup(async url => url === 'edges.json'
    ? {ok: true, json: async () => [['A', 'B', 11], ['B', 'C', 11], ['C', 'D', 11]]} : chosenStations(url), chosen.store);
  await flush();
  assert.deepEqual(reopened.elements['route-list'].children.map(rowName), ['Alpha (A)', 'Beta (B)', 'Extra (X)', 'Gamma (C)', 'Delta (D)']);
  assert.deepEqual(reopened.elements['route-list'].children.map(li => rowBox(li).checked), [true, false, true, true, true]);
  assert.match(reopened.elements['route-status'].textContent, /^Save kiya hua route: Alpha se Delta\. 4 \/ 5 station/);
  assert.equal(reopened.elements.origin.value, 'Alpha (A)'); // typed as "A": the box shows the station found
  reopened.elements['route-clear'].onclick();
  assert.equal(reopened.store.has('safar-route'), false);
  assert.equal(reopened.elements['route-details'].hidden, true);
  assert.match(reopened.elements['clock-hm'].textContent, /^\d\d:\d\d$/);
  assert.match(reopened.elements['clock-sec'].textContent, /^\d\d$/);
  assert.match(reopened.elements['clock-date'].textContent, /^[A-Z][a-z]+day, \d\d [A-Z][a-z]{2} \d{4}$/);
  assert.equal(typeof reopened.elements.clockTick, 'function');

  // The limits: a station counts within 250 m, the train is stopped below 0.75 m/s (2.7 km/h), and a stop of
  // 15 seconds or more is a halt.
  const limits = setup(stationFetcher([['LIM', 'Limit Station', 28, 77]]));
  limits.elements.start.onclick();
  limits.watches[0].success(fix(27.99, 100000));
  await flush();
  limits.watches[0].success(fix(27.9975, 110000));          // 278 m away: outside the station
  limits.watches[0].success(fix(27.9975, 130000, 0));       // standing there is a stop on the way, not at the station
  limits.watches[0].success(fix(27.998, 160000));           // 222 m away: inside
  limits.watches[0].success(fix(28, 170000, 0.7));          // below 0.75 m/s: stopped
  limits.watches[0].success(fix(28, 190000, 0.8));          // above it: moving again, 20 s later
  limits.watches[0].success(fix(28.01, 260000));
  const limitLog = JSON.parse(limits.store.get('trainlog'));
  const stationEntry = limitLog.find(entry => entry.id === 'LIM');
  assert.deepEqual([stationEntry.type, stationEntry.arr, stationEntry.dep], ['halt', 170000, 190000]);
  assert.ok(limitLog.some(entry => /^Raste mein \(Limit Station se 0\.28 km\)$/.test(entry.name) && entry.arr === 110001));   // same spot since the fix at 110000: the silence counts

  // Screen off: the page hears nothing while the train passes a station, but the app kept the fixes. When the
  // page runs again it reads them and the log has the station, at the time the train was really there.
  const missed = [];
  let liveFix, buffersCleared = 0, sessionsEnded = 0, settingsOpened = 0;
  let backgroundState = {backgroundLocation: false, batteryUnrestricted: false, notifications: true, version: 100080};
  const asleep = setup(stationFetcher([['SLP', 'Sleep Station', 28, 77.0005]]), null, {
    isNativePlatform: () => true,
    registerPlugin: name => name === 'SafarBuffer'
      ? {
        drain: async ({after}) => ({fixes: missed.filter(f => f.time > after)}),
        begin: async () => { buffersCleared++; },
        end: async () => { sessionsEnded++; },
        status: async () => backgroundState,
        openSettings: async () => { settingsOpened++; }
      }
      : {addWatcher: async (_options, callback) => { liveFix = callback; return 'w'; }, removeWatcher: async () => {}}
  });
  asleep.elements.start.onclick();
  await flush();
  assert.equal(buffersCleared, 1);
  liveFix({latitude: 27.98, longitude: 77, accuracy: 10, speed: 27, time: 100000}, null);
  await flush();
  for (let i = 1; i <= 100; i++)
    missed.push({time: 100000 + i * 2000, latitude: Math.round((27.98 + i * 0.0005) * 1e4) / 1e4, longitude: 77, accuracy: 10, speed: 27});
  assert.equal(asleep.store.has('trainlog'), false);
  // The page says what Android still needs for tracking with the screen off, and when it is all in place.
  const backgroundCard = asleep.elements['background-status'];
  assert.match(backgroundCard.children[0].textContent, /"Allow all the time" karein · Battery "Unrestricted \/ No restrictions" karein · app version 100080$/);
  assert.equal(backgroundCard.hidden, false);
  // With something missing there is a button that opens the phone's settings for the app.
  assert.equal(backgroundCard.children[1].textContent, 'Phone ki settings kholein');
  backgroundCard.children[1].onclick();
  assert.equal(settingsOpened, 1);
  backgroundState = {backgroundLocation: true, batteryUnrestricted: true, notifications: true, version: 100080};
  await asleep.elements.intervals.find(timer => timer.ms === 5000).fn();
  await flush();
  assert.match(backgroundCard.children[0].textContent, /settings theek hain ✓ · app version 100080$/);
  assert.equal(backgroundCard.children.length, 1);
  const sleptLog = JSON.parse(asleep.store.get('trainlog'));
  assert.deepEqual(sleptLog.map(entry => [entry.id, entry.type, entry.t]), [['SLP', 'pass', 180000]]);
  // A fix the page already read from the buffer is not used twice when it arrives late.
  liveFix({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 180000}, null);
  liveFix({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 290000}, null);
  assert.equal(JSON.parse(asleep.store.get('trainlog')).length, 1);
  assert.match(asleep.elements.status.textContent, /Location mil rahi hai/);
  await asleep.elements.stop.onclick();
  assert.equal(sessionsEnded, 1);
  assert.equal(asleep.elements['background-status'].hidden, true);

  // The native list as the app really keeps it: every fix the plugin gives is in it, and it outlives the page.
  // While the page is held up (screen off) it gets no fixes; when it runs again, a live fix may reach it before the
  // next drain. It still takes the fixes it missed first, so a station passed meanwhile is in the log. Then the page
  // is closed and opened again during the journey (Android may do that while the screen is off): the journey is
  // taken up from the last fix the page had, the native list is kept (not dropped as for a new journey), and a
  // station passed while the page was closed is in the log too, at the time the train was there.
  const kept = [], keepAsked = [];
  let watcher = null;
  const nativeList = name => name === 'SafarBuffer'
    ? {
      drain: async ({after}) => ({fixes: kept.filter(f => f.time > after)}),
      begin: async ({keep} = {}) => { keepAsked.push(keep); if (!keep) kept.length = 0; },
      end: async () => {}, status: async () => ({})
    }
    : {addWatcher: async (_options, callback) => { watcher = callback; return 'w'; }, removeWatcher: async () => {}};
  const along = i => ({time: 100000 + i * 2000, latitude: Math.round((27.98 + i * 0.0005) * 1e4) / 1e4, longitude: 77, accuracy: 10, speed: 27});
  const twoStations = stationFetcher([['ONE', 'Station One', 28, 77.0005], ['TWO', 'Station Two', 28.05, 77.0005]]);
  const firstPage = setup(twoStations, null, {isNativePlatform: () => true, registerPlugin: nativeList});
  firstPage.elements.start.onclick();
  await flush();
  for (let i = 0; i <= 10; i++) { kept.push(along(i)); watcher(along(i), null); }
  await flush();
  for (let i = 11; i <= 60; i++) kept.push(along(i));      // the page is held up: Station One passes at 180000
  kept.push(along(61));
  watcher(along(61), null);                                // the first fix the page hears again
  await flush();
  assert.deepEqual(JSON.parse(firstPage.store.get('trainlog')).map(entry => [entry.id, entry.type, entry.t]), [['ONE', 'pass', 180000]]);
  watcher = null;                                          // the page is closed; Station Two passes at 380000
  for (let i = 62; i <= 200; i++) kept.push(along(i));
  const secondPage = setup(twoStations, firstPage.store, {isNativePlatform: () => true, registerPlugin: nativeList});
  await flush();
  await flush();
  assert.deepEqual(keepAsked, [false, true]);
  assert.deepEqual(JSON.parse(secondPage.store.get('trainlog')).map(entry => [entry.id, entry.type, entry.t]),
    [['ONE', 'pass', 180000], ['TWO', 'pass', 380000]]);
  await secondPage.elements.stop.onclick();

  // A standing train with the screen off: the phone sends no fixes while it sits still. The silence is filled in
  // as a stop from the last fix, so the halt has its real start, not the time fixes came back.
  const silent = setup(stationFetcher([['SIL', 'Silent Station', 28, 77.0005]]));
  silent.elements.start.onclick();
  silent.watches[0].success(fix(27.98, 100000, 27));
  await flush();
  for (let i = 1; i <= 40; i++) silent.watches[0].success(fix(Math.round((27.98 + i * 0.0005) * 1e4) / 1e4, 100000 + i * 2000, i === 40 ? 4 : 27));
  // The last fix, at the platform, still shows the train rolling in at 4 m/s. Then four minutes of silence.
  assert.equal(silent.elements['live-stop'].hidden, true);
  silent.watches[0].success(fix(28.0001, 420000, 3));       // rolling out again, 11 m on
  assert.equal(silent.elements['live-stop'].hidden, true);
  for (let i = 1; i <= 10; i++) silent.watches[0].success(fix(Math.round((28.0001 + i * 0.0005) * 1e4) / 1e4, 420000 + i * 2000, 27));
  const silentEntry = JSON.parse(silent.store.get('trainlog'))[0];
  assert.deepEqual([silentEntry.id, silentEntry.type, silentEntry.arr, silentEntry.dep], ['SIL', 'halt', 180001, 420000]);

  // The stop in progress shows above the log as soon as it counts, at a station by the station's name.
  const standing = setup(stationFetcher([['STD', 'Standing Station', 28, 77.0005]]));
  standing.elements.start.onclick();
  standing.watches[0].success(fix(27.999, 100000, 27));
  await flush();
  standing.watches[0].success(fix(28, 104000, 0));
  standing.watches[0].success(fix(28, 110000, 0));
  assert.equal(standing.elements['live-stop'].hidden, true);  // 6 seconds: not a halt yet
  standing.watches[0].success(fix(28, 119000, 0));
  assert.match(standing.elements['live-stop'].textContent, /^Abhi ruki hai: Standing Station \(STD\) — .+ se \(0\.3 min\)$/);
  standing.watches[0].success(fix(28.0005, 130000, 10));
  assert.equal(standing.elements['live-stop'].hidden, true);

  // Rings. The train runs north along longitude 77 in 55 m steps; 0.001 degrees of longitude is about 98 m here.
  const drive = (app, from, to, t0, speed = 27) => {
    const watch = app.watches[app.watches.length - 1];
    let t = t0;
    for (let lat = from; lat <= to + 1e-9; lat += 0.0005, t += 2000) watch.success(fix(Math.round(lat * 1e4) / 1e4, t, speed));
    return t;
  };
  const logIds = app => JSON.parse(app.store.get('trainlog') || '[]').map(entry => entry.id);

  // A station passed within 100 m is written as soon as the train is 250 m past it, not at the edge of the zone;
  // one that was in range at the same time but only reached a wide ring is dropped.
  const rings = setup(stationFetcher([['CLS', 'Close', 28, 77.0005], ['WID', 'Wide', 28.002, 77.006]]));
  rings.elements.start.onclick();
  rings.watches[0].success(fix(27.98, 100000, 27));
  await flush();
  let clock = drive(rings, 27.9805, 28.002, 102000);
  assert.deepEqual(logIds(rings), []);                       // 222 m past: still inside the 250 m ring
  clock = drive(rings, 28.0025, 28.003, clock);
  assert.deepEqual(logIds(rings), ['CLS']);                  // 278 m past: written, 700 m before the zone ends
  const closeEntry = JSON.parse(rings.store.get('trainlog'))[0];
  assert.equal(closeEntry.type, 'pass');
  assert.ok(closeEntry.near >= 45 && closeEntry.near <= 55);
  assert.match(rings.elements.log.children[0].children[1].textContent, /^Paar kiya: .+ · \d+ m paas se$/);
  drive(rings, 28.0035, 28.03, clock);
  assert.deepEqual(logIds(rings), ['CLS']);                  // Wide (589 m off the line) was beaten by Close

  // A station whose listed position is 589 m off the line is still found, by the 750 m ring, once the zone is left.
  const wide = setup(stationFetcher([['WID', 'Wide', 28, 77.006]]));
  wide.elements.start.onclick();
  wide.watches[0].success(fix(27.98, 100000, 27));
  await flush();
  clock = drive(wide, 27.9805, 28.007, 102000);
  assert.deepEqual(logIds(wide), []);                        // 779 m along: 976 m away, still in the zone
  drive(wide, 28.0075, 28.01, clock);
  assert.deepEqual(logIds(wide), ['WID']);
  const wideEntry = JSON.parse(wide.store.get('trainlog'))[0];
  assert.ok(wideEntry.near >= 580 && wideEntry.near <= 600);

  // Two stations both passed closely are both written, though they were in range together.
  const pair = setup(stationFetcher([['ONE', 'One', 28, 77.0005], ['TWO', 'Two', 28.004, 77.002]]));
  pair.elements.start.onclick();
  pair.watches[0].success(fix(27.98, 100000, 27));
  await flush();
  drive(pair, 27.9805, 28.03, 102000);
  assert.deepEqual(logIds(pair), ['ONE', 'TWO']);

  // Stop pressed while standing at a station: the halt so far is written, not lost.
  const arrived = setup(stationFetcher([['END', 'Terminus', 28, 77.0005]]));
  arrived.elements.start.onclick();
  arrived.watches[0].success(fix(27.98, 100000, 27));
  await flush();
  clock = drive(arrived, 27.9805, 28, 102000);
  arrived.watches[0].success(fix(28, clock, 0));
  arrived.watches[0].success(fix(28, clock + 60000, 0));
  arrived.elements.stop.onclick();
  const endEntry = JSON.parse(arrived.store.get('trainlog'))[0];
  assert.deepEqual([endEntry.id, endEntry.type, endEntry.arr, endEntry.dep], ['END', 'halt', clock, clock + 60000]);

  // Full-screen clock: only the look changes; a station passed meanwhile is still logged, with its speed shown.
  const big = setup(stationFetcher([['TST', 'Test Station', 28, 77]]));
  big.elements.start.onclick();
  big.elements['clock-full'].onclick();
  assert.equal(big.elements.body.className, 'clockmode');
  assert.equal(big.elements['clock-full'].innerHTML, 'EXIT');
  big.watches[0].success(fix(27.99, 100000));
  await flush();
  big.watches[0].success(fix(28, 110000));
  big.watches[0].success(fix(28.01, 120000));
  assert.equal(JSON.parse(big.store.get('trainlog'))[0].id, 'TST');
  assert.equal(big.elements.speed.textContent, '36');
  big.elements['clock-full'].onclick();
  assert.equal(big.elements.body.className, '');
  // Ten colours for the time in a dropdown that shows the colours themselves; the pick is kept for the next start.
  const menu = big.elements['clock-color-menu'];
  assert.equal(menu.children.length, 10);
  assert.ok(menu.children.every(choice => !choice.textContent && /^#[0-9a-f]{6}$/.test(choice.style.background)));
  assert.equal(menu.hidden, true);
  assert.equal(big.elements['clock-time'].style.color, '#f8fafc');
  big.elements['clock-color'].onclick();
  assert.equal(menu.hidden, false);
  menu.children[4].onclick();
  assert.equal(menu.hidden, true);
  assert.equal(big.elements['clock-time'].style.color, '#f472b6');
  assert.equal(big.elements['clock-color-now'].style.background, '#f472b6');
  const recoloured = setup(stationFetcher([['TST', 'Test Station', 28, 77]]), big.store);
  assert.equal(recoloured.elements['clock-time'].style.color, '#f472b6');
  assert.equal(recoloured.elements['clock-color-now'].style.background, '#f472b6');
  assert.match(big.elements['clock-full'].innerHTML, /^<svg /);

  chosen.elements['route-none'].onclick();
  assert.match(chosen.elements['route-choice'].textContent, /^0 \/ 5 station/);
  chosen.elements['route-all'].onclick();
  assert.match(chosen.elements['route-choice'].textContent, /^5 \/ 5 station/);

  // Every station of both lists is offered, each at its own position: the catalog's entry with its code and
  // OpenStreetMap's entry by name, without its internal id.
  const labels = text => {
    bundled.elements.origin.dataset = {};
    bundled.elements.origin.value = text;
    bundled.elements.origin.oninput();
    return bundled.elements['origin-options'].children.map(option => option.textContent);
  };
  assert.deepEqual(labels('Baruna').filter(label => /^baruna( \(|$)/i.test(label)).sort(), ['BARUNA (BUE)', 'Baruna']);
  assert.ok(labels('Deen Dayal Upadhyaya').includes('Deen Dayal Upadhyaya Junction'));
  // An OpenStreetMap station shows the code OSM has for it and is found by it, unless the catalog already has a
  // station of that code or one renamed to it: then only the catalog's entry carries it, so that a typed code
  // names one station and a route does not get the same junction twice.
  assert.equal(labels('EKNR')[0], 'Kevadiya (EKNR)');
  assert.equal(labels('NKMG')[0], 'New Karimganj Junction (NKMG)');
  assert.deepEqual(labels('PRYJ').filter(label => /PRYJ/.test(label)), ['ALLAHABAD JN (ALD) — ab Prayagraj Jn (PRYJ)']);
  assert.deepEqual(labels('DDU').filter(label => /\(DDU\)/.test(label)), ['MUGHAL SARAI JN (MGS) — ab Deen Dayal Upadhyaya Jn (DDU)']);
  assert.deepEqual(labels('Baruna').filter(label => /\(BUE\)/.test(label)), ['BARUNA (BUE)']);
  assert.ok(labels('Deen Dayal Upadhyaya').includes('MUGHAL SARAI JN (MGS) — ab Deen Dayal Upadhyaya Jn (DDU)'));
  assert.ok(labels('Baruna').every(label => !/OSM:/.test(label)));

  // No route chosen: the next station is the nearest one ahead in the direction of travel (Buxar towards DDU).
  const free = setup(async url => ({ok: true, json: async () => read(url)}));
  await flush();
  free.elements.start.onclick();
  const at = (lat, lon, t) => ({coords: {latitude: lat, longitude: lon, accuracy: 4, speed: 30}, timestamp: t});
  free.watches[0].success(at(25.5600, 83.9600, 100000));
  assert.match(free.elements.next.textContent, /train chalne par dikhega/);
  free.watches[0].success(at(25.5560, 83.9300, 200000));
  assert.match(free.elements.next.textContent, /Agla station \(disha se anumaan\): .+\), \d+\.\d\d km/);
  assert.doesNotMatch(free.elements.next.textContent, /BUXAR/);
  console.log('Safar tracker checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
