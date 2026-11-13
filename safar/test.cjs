const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(fetch, saved, capacitor = null, screen = null) {
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
  const context = {document, localStorage, navigator: {geolocation}, window: {Capacitor: capacitor, ...screen}, fetch, AbortController, setTimeout, clearTimeout, setInterval: (fn, ms) => { (elements.intervals ||= []).push({fn, ms}); elements.clockTick = fn; return 0; }, String,
    console, Date, Math, Number, JSON, Blob, URL, confirm: () => true};
  vm.runInNewContext(script, context);
  return {elements, store, watches, context};
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
  assert.match(app.elements['data-status'].textContent, /ready/);
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
  assert.match(slow.elements.status.textContent, /Location found/);
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
  assert.match(noData.elements['data-status'].textContent, /Check the internet/);
  assert.equal(noData.elements['data-status'].hidden, false);
  assert.equal(noData.store.has('trainlog'), false);

  const inaccurate = setup(stationFetcher([['TST', 'Test Station', 28, 77]]));
  inaccurate.elements.start.onclick();
  inaccurate.watches[0].success(fix(28, 100000, 10, 1000));
  await flush();
  assert.match(inaccurate.elements.status.textContent, /Accuracy is low/);
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
  assert.match(legacyOffline.elements['data-status'].textContent, /Saved station list in use/);

  const database = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'stations.json'), 'utf8'));
  assert.equal(database.length, 8703);
  const delhi = database.find(row => row[0] === 'NDLS');
  assert.equal(delhi[1], 'NEW DELHI');

  // ---- Where stations stand. The DataMeet catalog had some stations written down at the spot of a neighbouring,
  // differently named station: Muthani (MTGE) sat 30 m from Bhabua Road (BBU), so passing Bhabua Road logged
  // Muthani as well, and the real Muthani, 5 km on, went by. Such a station stands where OpenStreetMap has it under
  // the same code and name, when that spot is on its line: between two of its neighbours.
  const straight = (a, b) => {   // the catalog's own measure of a link: a straight line on a sphere of 6371 km
    const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };
  const placeOf = code => database.find(row => row[0] === code).slice(2, 4);
  assert.ok(straight(placeOf('MTGE'), [25.1420, 83.6613]) < 0.3, 'Muthani stands at Muthani');   // as Wikipedia has it
  assert.ok(straight(placeOf('BBU'), [25.1728, 83.6173]) < 0.3, 'Bhabua Road stays at Bhabua Road');
  const muthaniGap = straight(placeOf('MTGE'), placeOf('BBU'));
  assert.ok(muthaniGap > 4.5 && muthaniGap < 6.5, `Muthani is about 5 km from Bhabua Road, not ${muthaniGap}`);
  // Every link between two stations is as long as the straight line between them, a moved station's too.
  const links = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'edges.json'), 'utf8'));
  const rowOf = new Map(database.map(row => [row[0], row]));
  assert.deepEqual(links.filter(([a, b, length]) => rowOf.has(a) && rowOf.has(b)
    && Math.abs(length - straight(rowOf.get(a).slice(2), rowOf.get(b).slice(2))) > 0.002), []);
  // And no station is left on top of a differently named one while OpenStreetMap has it, under its code and name,
  // more than a kilometre away and on its line.
  const mapped = new Map();
  for (const row of JSON.parse(fs.readFileSync(require('path').join(__dirname, 'osm-stations.json'), 'utf8')))
    if (row[4]) mapped.set(row[4], [...(mapped.get(row[4]) || []), row]);
  const letters = name => name.toUpperCase().replace(/JUNCTION/g, 'JN').replace(/ROAD/g, 'RD').replace(/HALT/g, '').replace(/[^A-Z]/g, '');
  const neighbours = new Map();
  for (const [a, b] of links) neighbours.set(a, [...(neighbours.get(a) || []), b]);
  const byLatitude = [...database].sort((a, b) => a[2] - b[2]), onTop = [];
  for (let i = 0; i < byLatitude.length; i++) for (let j = i + 1; j < byLatitude.length && byLatitude[j][2] - byLatitude[i][2] <= 0.002; j++) {
    const pair = [byLatitude[i], byLatitude[j]];
    if (straight(pair[0].slice(2), pair[1].slice(2)) >= 0.1 || letters(pair[0][1]) === letters(pair[1][1])) continue;
    for (const [me, other] of [pair, [pair[1], pair[0]]]) for (const there of mapped.get(me[0]) || []) {
      const spot = there.slice(2, 4);
      if (letters(there[1]).slice(0, 5) !== letters(me[1]).slice(0, 5) || straight(me.slice(2), spot) <= 1) continue;
      const near = (neighbours.get(me[0]) || []).filter(code => rowOf.has(code)).map(code => rowOf.get(code).slice(2));
      if (near.some((x, n) => near.slice(n + 1).some(y => straight(x, y) > 0.5
        && (straight(x, spot) + straight(spot, y)) / straight(x, y) <= 1.2))) onTop.push(`${me[0]} on ${other[0]}`);
    }
  }
  assert.deepEqual(onTop, []);
  // OpenStreetMap's list holds only places where trains stop. OSM maps bus stands, ferry ghats, taxi stands and
  // ropeways as public-transport stations too; 3,486 of them were in the list, and passing near one logged it as a
  // station. A public-transport station on a track stays (OSM has some railway stations mapped only that way).
  const osmList = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'osm-stations.json'), 'utf8'));
  const osmIds = new Set(osmList.map(row => row[0]));
  assert.equal(osmList.length, 3494);
  for (const [id, what] of [['OSM:306104406', "Chennai's bus terminus"], ['OSM:6868662856', "Karimnagar's bus station"],
    ['OSM:13280854188', 'a boat jetty in Kerala']]) assert.ok(!osmIds.has(id), `${what} is not a station`);
  assert.ok(osmIds.has('OSM:2064788425') && osmIds.has('OSM:718549318'), 'stations mapped only as public transport on a track stay');
  // An OSM station with the catalog's code (or the code a catalog station was renamed to) within a kilometre of that
  // catalog station is the same station: it stays in the list, without the code, marked as that station. Farther
  // off it is only without the code; with a code the catalog lacks it keeps its code.
  const combine = setup(stationFetcher([['TST', 'Test Station', 28, 77]])).context.combineStations;
  assert.deepEqual(combine(
    [{id: 'MTGE', name: 'MUTHANI', lat: 25.1420, lon: 83.6617}, {id: 'BBU', name: 'BHABUA ROAD', lat: 25.1730, lon: 83.6189},
      {id: 'MGS', name: 'MUGHAL SARAI JN', lat: 25.2800, lon: 83.1200}],
    [{id: 'OSM:1', name: 'Muthani', lat: 25.1425, lon: 83.6610, code: 'MTGE'},
      {id: 'OSM:2', name: 'Bhabua Road', lat: 25.1500, lon: 83.6189, code: 'BBU'},
      {id: 'OSM:3', name: 'Pt. Deen Dayal Upadhyaya Junction', lat: 25.2803, lon: 83.1196, code: 'DDU'},
      {id: 'OSM:4', name: 'New Halt', lat: 25.2, lon: 83.7, code: 'NWH'}]).map(s => [s.id, s.code, s.sameAs]),
    [['MTGE', undefined, undefined], ['BBU', undefined, undefined], ['MGS', undefined, undefined], ['OSM:1', undefined, 'MTGE'],
      ['OSM:2', undefined, undefined], ['OSM:3', undefined, 'MGS'], ['OSM:4', 'NWH', undefined]]);
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
  assert.match(routed.elements['route-status'].textContent, /Route ready: 3 stations/);
  assert.deepEqual(routed.elements['route-list'].children.map(rowName), ['SON NAGAR (SEB)', 'ADSR (ADSR)', 'DEHRI ON SONE (DOS)']);
  // Its tick taken off, it is not logged though the train passes right over it.
  const adsrBox = routed.elements['route-list'].children[1].children[0].children[0];
  adsrBox.checked = false;
  adsrBox.onchange();
  routed.elements.start.onclick();
  routed.watches[0].success({coords: {latitude: 24.9, longitude: 84.208, accuracy: 4, speed: 10}, timestamp: 100000});
  assert.match(routed.elements.next.textContent, /Likely next station: DEHRI ON SONE \(DOS\)/);
  assert.equal(routed.elements.speed.textContent, '36');
  routed.watches[0].success({coords: {latitude: 24.909345, longitude: 84.192214, accuracy: 4, speed: 10}, timestamp: 160000});
  routed.watches[0].success({coords: {latitude: 24.914895, longitude: 84.185434, accuracy: 4, speed: 10}, timestamp: 220000});
  assert.doesNotMatch(routed.store.get('trainlog') || '', /ADSR/);
  routed.watches[0].success({coords: {latitude: 25.5, longitude: 85, accuracy: 4, speed: 10}, timestamp: 280000});
  // Off the chosen route the tracker keeps going: the next station comes from the direction of travel.
  assert.match(routed.elements.next.textContent, /Next station \(estimated from direction\): .+ km/);
  await routed.elements['find-route'].onclick();
  assert.match(routed.elements['route-status'].textContent, /^Press Stop before changing the route/);

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
  assert.match(osmRoute.elements['route-status'].textContent, /Route ready: 2 stations/);
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
  assert.match(badRoute.elements['route-status'].textContent, /no path found between these stations/);

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
  pick('origin', 'origin-options', 'Deen Dayal Upadhyaya', 'MUGHAL SARAI JN (MGS) — now Deen Dayal Upadhyaya Jn (DDU)');
  pick('destination', 'destination-options', 'ALD', 'ALLAHABAD JN (ALD) — now Prayagraj Jn (PRYJ)');
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /Route ready: \d+ stations, about 1\d\d km/);
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
  assert.match(firstOption('DDU'), /^MUGHAL SARAI JN \(MGS\) — now Deen Dayal Upadhyaya Jn \(DDU\)$/);
  assert.match(firstOption('PRYJ'), /^ALLAHABAD JN \(ALD\)/);
  assert.match(firstOption('prayagraj jn'), /^ALLAHABAD JN \(ALD\)/);
  bundled.elements.origin.dataset = {};
  bundled.elements.origin.value = 'DDU';
  bundled.elements.destination.dataset = {};
  bundled.elements.destination.value = 'PRYJ';
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /Route ready/);
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
  assert.match(outer.elements['live-stop'].textContent, /^Stopped now: On the way \(6\.\d\d km from Halt\) — since .+ \(1 min\)$/);
  assert.equal(outer.elements['live-stop'].hidden, false);
  outer.watches[0].success(fix(28.061, 270000, 10));
  const outerLog = JSON.parse(outer.store.get('trainlog'));
  assert.equal(outerLog.length, 1);
  assert.match(outerLog[0].name, /^On the way \(6\.\d\d km from Halt\)$/);
  assert.deepEqual([outerLog[0].type, outerLog[0].arr, outerLog[0].dep], ['halt', 200000, 270000]);
  // Stops on the way that earlier versions wrote down in Hinglish ("Raste mein (NAME se 1.20 km)") show in English.
  const older = setup(stationFetcher([['TST', 'Test Station', 28, 77]]), [['trainlog', JSON.stringify([
    {name: 'Raste mein (BUXAR se 1.20 km)', id: '', source: 'GPS', type: 'halt', arr: 1000, dep: 61000},
    {name: 'Raste mein', id: '', source: 'GPS', type: 'halt', arr: 70000, dep: 130000}])]]);
  assert.deepEqual(older.elements.log.children.map(card => card.children[0].textContent), ['On the way', 'On the way (1.20 km from BUXAR)']);
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
  pick('origin', 'origin-options', 'DDU', 'MUGHAL SARAI JN (MGS) — now Deen Dayal Upadhyaya Jn (DDU)');
  pick('destination', 'destination-options', 'ALD', 'ALLAHABAD JN (ALD) — now Prayagraj Jn (PRYJ)');
  await bundled.elements['find-route'].onclick();
  assert.ok(routeNames().includes('VARANASI JN (BSB)'));
  assert.ok(!routeNames().includes('MIRZAPUR (MZP)'));
  bundled.elements['add-via'].onclick();
  assert.equal(bundled.elements['via-row-1'].hidden, false);
  pickVia(1, 'MZP', 'MIRZAPUR (MZP)');
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /^Route ready \(via MIRZAPUR\): \d+ stations/);
  const viaRoute = routeNames();
  assert.equal(viaRoute[0], 'MUGHAL SARAI JN (MGS)');
  assert.equal(viaRoute[viaRoute.length - 1], 'ALLAHABAD JN (ALD)');
  assert.ok(viaRoute.includes('MIRZAPUR (MZP)') && !viaRoute.includes('VARANASI JN (BSB)'));
  assert.equal(viaRoute.filter(name => name === 'MIRZAPUR (MZP)').length, 1);
  // A via box with text that is no station stops the route; an empty one is skipped.
  bundled.elements['via-1'].dataset = {};
  bundled.elements['via-1'].value = 'zzzz';
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /Via station 1 not found/);
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
  assert.match(bundled.elements['route-status'].textContent, /^Route ready \(via MIRZAPUR\)/);
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
  pick('origin', 'origin-options', 'DDU', 'MUGHAL SARAI JN (MGS) — now Deen Dayal Upadhyaya Jn (DDU)');
  assert.equal(bundled.elements['via-1'].value, '');
  assert.equal(bundled.elements['via-row-1'].hidden, true);
  assert.equal(bundled.elements['add-via'].hidden, false);
  await bundled.elements['find-route'].onclick();
  assert.match(bundled.elements['route-status'].textContent, /^Route ready: \d+ stations/);
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

  // The journey from the report, on the real data: down the Grand Chord from before Bhabua Road to past Pusauli, a
  // fix every 2 seconds at 90 km/h. Bhabua Road, Muthani and Pusauli are each logged once, as the train reaches
  // them, with a route and without one. (Muthani was logged at Bhabua Road; without a route OSM's own Muthani was
  // logged as well, and once both stood at Muthani it would have been logged twice there.)
  const toward = (a, b, share) => [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share];
  for (const withRoute of [true, false]) {
    const chord = setup(async url => ({ok: url in realFiles, json: async () => realFiles[url]}));
    await flush();
    if (withRoute) {
      chord.elements.origin.value = 'BBU';
      chord.elements.destination.value = 'PSE';
      await chord.elements['find-route'].onclick();
      assert.deepEqual(chord.elements['route-list'].children.map(rowName), ['BHABUA ROAD (BBU)', 'MUTHANI (MTGE)', 'PUSAULI (PSE)']);
    }
    chord.elements.start.onclick();
    const [bhabua, muthani, pusauli] = ['BBU', 'MTGE', 'PSE'].map(placeOf);
    let when = 1000000;
    for (const [from, to] of [[toward(bhabua, muthani, -0.3), bhabua], [bhabua, muthani], [muthani, pusauli], [pusauli, toward(muthani, pusauli, 1.2)]]) {
      const steps = Math.max(1, Math.round(straight(from, to) / 0.05));
      for (let step = 0; step < steps; step++, when += 2000) {
        const [latitude, longitude] = toward(from, to, step / steps);
        chord.watches[0].success({coords: {latitude, longitude, accuracy: 10, speed: 25}, timestamp: when});
      }
    }
    const chordLog = JSON.parse(chord.store.get('trainlog'));
    const what = withRoute ? 'with a route' : 'without a route';
    assert.deepEqual(chordLog.map(entry => entry.id), ['BBU', 'MTGE', 'PSE'], what);
    assert.ok(chordLog[1].t - chordLog[0].t > 180000, `${what}: Muthani is passed minutes after Bhabua Road`);
  }

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
  assert.match(chosen.elements['add-station-status'].textContent, /from this route; not added/);
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
  assert.match(chosen.elements['route-status'].textContent, /^Saved: Alpha to Delta, 4 \/ 5 stations/);
  assert.equal(chosen.elements['route-details'].open, false);
  const reopened = setup(async url => url === 'edges.json'
    ? {ok: true, json: async () => [['A', 'B', 11], ['B', 'C', 11], ['C', 'D', 11]]} : chosenStations(url), chosen.store);
  await flush();
  assert.deepEqual(reopened.elements['route-list'].children.map(rowName), ['Alpha (A)', 'Beta (B)', 'Extra (X)', 'Gamma (C)', 'Delta (D)']);
  assert.deepEqual(reopened.elements['route-list'].children.map(li => rowBox(li).checked), [true, false, true, true, true]);
  assert.match(reopened.elements['route-status'].textContent, /^Saved route: Alpha to Delta\. 4 \/ 5 stations/);
  assert.equal(reopened.elements.origin.value, 'Alpha (A)'); // typed as "A": the box shows the station found
  reopened.elements['route-clear'].onclick();
  assert.equal(reopened.store.has('safar-route'), false);
  assert.equal(reopened.elements['route-details'].hidden, true);
  assert.match(reopened.elements['clock-hm'].textContent, /^\d\d:\d\d$/);
  assert.match(reopened.elements['clock-sec'].textContent, /^\d\d$/);
  assert.match(reopened.elements['clock-date'].textContent, /^[A-Z][a-z]+day, \d\d [A-Z][a-z]{2} \d{4}$/);
  assert.equal(typeof reopened.elements.clockTick, 'function');

  // The limits: a station counts within 250 m, the train is stopping below 5 km/h (1.39 m/s), and a stop of
  // 15 seconds or more is a halt. A train that only crawled, never below 2.7 km/h, moves off again at 5 km/h.
  const limits = setup(stationFetcher([['LIM', 'Limit Station', 28, 77]]));
  limits.elements.start.onclick();
  limits.watches[0].success(fix(27.99, 100000));
  await flush();
  limits.watches[0].success(fix(27.9975, 110000));          // 278 m away: outside the station
  limits.watches[0].success(fix(27.9975, 130000, 0));       // standing there is a stop on the way, not at the station
  limits.watches[0].success(fix(27.998, 160000));           // 222 m away: inside
  limits.watches[0].success(fix(28, 170000, 1.3));          // 4.7 km/h, below 5 km/h: stopped
  limits.watches[0].success(fix(28, 180000, 1.0));          // 3.6 km/h: still stopping (it was moving below 2.7 km/h)
  limits.watches[0].success(fix(28, 190000, 1.4));          // 5.04 km/h: moving again, 20 s after it stopped
  limits.watches[0].success(fix(28.01, 260000));
  const limitLog = JSON.parse(limits.store.get('trainlog'));
  const stationEntry = limitLog.find(entry => entry.id === 'LIM');
  assert.deepEqual([stationEntry.type, stationEntry.arr, stationEntry.dep], ['halt', 170000, 190000]);
  assert.ok(limitLog.some(entry => /^On the way \(0\.28 km from Limit Station\)$/.test(entry.name) && entry.arr === 110001));   // same spot since the fix at 110000: the silence counts

  // Standing still, the train moves off at 2.7 km/h, as asked: the halt runs from the first reading below 5 km/h to
  // the first at 2.7 km/h or more, and the train speeding up from there (3.6 and 4.3 km/h) is not a new stop.
  const metre = 1 / 111320;
  const still = setup(stationFetcher([['STL', 'Still Station', 28, 77]]));
  still.elements.start.onclick();
  still.watches[0].success(fix(27.995, 100000));
  await flush();
  still.watches[0].success(fix(28, 110000, 1.3));            // 4.7 km/h: stopping
  still.watches[0].success(fix(28, 115000, 0.2));            // standing
  still.watches[0].success(fix(28, 140000, 0.2));            // 25 s later, same spot
  still.watches[0].success(fix(28, 150000, 0.8));            // 2.9 km/h: moved off
  still.watches[0].success(fix(28 + 5 * metre, 155000, 1.0));
  still.watches[0].success(fix(28 + 29 * metre, 175000, 1.2));
  still.watches[0].success(fix(28.01, 200000));
  const stillLog = JSON.parse(still.store.get('trainlog'));
  assert.deepEqual(stillLog.map(entry => [entry.id || entry.name, entry.type, entry.arr, entry.dep]),
    [['STL', 'halt', 110000, 150000]]);
  // Crawling at 3.6 km/h for 40 s, never standing: one halt, over when the train is at 5 km/h again (7.2 km/h here),
  // not a halt for every 15 seconds.
  const crawl = setup(stationFetcher([['CRL', 'Crawl Station', 28, 77]]));
  crawl.elements.start.onclick();
  crawl.watches[0].success(fix(27.995, 100000));
  await flush();
  for (let i = 0; i <= 8; i++) crawl.watches[0].success(fix(28 - (55 - 5 * i) * metre, 110000 + 5000 * i, 1.0));
  crawl.watches[0].success(fix(28 - 10 * metre, 155000, 2.0));
  crawl.watches[0].success(fix(28.01, 200000));
  assert.deepEqual(JSON.parse(crawl.store.get('trainlog')).map(entry => [entry.id || entry.name, entry.type, entry.arr, entry.dep]),
    [['CRL', 'halt', 110000, 155000]]);

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
  assert.match(backgroundCard.children[0].textContent, /location permission to "Allow all the time" · Set battery use to "Unrestricted \/ No restrictions" · app version 100080$/);
  assert.equal(backgroundCard.hidden, false);
  // With something missing there is a button that opens the phone's settings for the app.
  assert.equal(backgroundCard.children[1].textContent, 'Open phone settings');
  backgroundCard.children[1].onclick();
  assert.equal(settingsOpened, 1);
  backgroundState = {backgroundLocation: true, batteryUnrestricted: true, notifications: true, version: 100080};
  await asleep.elements.intervals.find(timer => timer.ms === 5000).fn();
  await flush();
  assert.match(backgroundCard.children[0].textContent, /settings are fine ✓ · app version 100080$/);
  assert.equal(backgroundCard.children.length, 1);
  const sleptLog = JSON.parse(asleep.store.get('trainlog'));
  assert.deepEqual(sleptLog.map(entry => [entry.id, entry.type, entry.t]), [['SLP', 'pass', 180000]]);
  // A fix the page already read from the buffer is not used twice when it arrives late.
  liveFix({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 180000}, null);
  liveFix({latitude: 28, longitude: 77, accuracy: 10, speed: 0, time: 290000}, null);
  assert.equal(JSON.parse(asleep.store.get('trainlog')).length, 1);
  assert.match(asleep.elements.status.textContent, /Location found/);
  await asleep.elements.stop.onclick();
  assert.equal(sessionsEnded, 1);
  assert.equal(asleep.elements['background-status'].hidden, true);

  // The native list as the app really keeps it: every fix the plugin gives is in it, and it outlives the page.
  // While the page is held up (screen off) it gets no fixes; when it runs again, a live fix may reach it before the
  // next drain. It still takes the fixes it missed first, so a station passed meanwhile is in the log. Then the page
  // is closed and opened again during the journey (Android may do that while the screen is off): the journey is
  // taken up from the last fix the page had, the native list is kept (not dropped as for a new journey), and a
  // station passed while the page was closed is in the log too, at the time the train was there.
  const kept = [], keepAsked = [], running = [];
  let watcher = null, watchers = 0;
  const nativeList = name => name === 'SafarBuffer'
    ? {
      drain: async ({after}) => ({fixes: kept.filter(f => f.time > after)}),
      begin: async ({keep} = {}) => { keepAsked.push(keep); if (!keep) kept.length = 0; },
      end: async () => {}, status: async () => ({})
    }
    : {
      addWatcher: async (_options, callback) => { watcher = callback; running.push('w' + ++watchers); return 'w' + watchers; },
      removeWatcher: async ({id}) => { if (running.includes(id)) running.splice(running.indexOf(id), 1); }
    };
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
  // The location service still ran the first page's watcher; the second page removed it once its own was running,
  // so after Stop none is left to keep the GPS and the notification on.
  assert.deepEqual(running, ['w2']);
  await secondPage.elements.stop.onclick();
  await flush();
  assert.deepEqual(running, []);

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
  assert.match(standing.elements['live-stop'].textContent, /^Stopped now: Standing Station \(STD\) — since .+ \(0\.3 min\)$/);
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
  assert.match(rings.elements.log.children[0].children[1].textContent, /^Passed: .+ · within \d+ m$/);
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

  // ---- Sizes of the full-screen clock. A small gear next to EXIT, there only in full screen, opens a bar where the
  // time (hours, minutes and seconds together), the speed dial and the date are each made larger or smaller, in two
  // ways: Auto, where the time and the date fill what the dial leaves them, and Custom, where each keeps its own size.
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a} against ${b}`);
  const tallness = box => box[3] - box[1], wideness = box => box[2] - box[0];
  const covers = (a, b) => a[0] < b[2] - 0.5 && b[0] < a[2] - 0.5 && a[1] < b[3] - 0.5 && b[1] < a[3] - 0.5;
  const within = (box, long, short) => box[0] >= -0.5 && box[1] >= -0.5 && box[2] <= long + 0.5 && box[3] <= short + 0.5;
  const layout = big.context.clockLayout;
  const measures = {width: 304, digit: 72, foot: 84, dateWide: 1150, dateTall: 117, dateTop: 59, buttonsWide: 92};
  const ones = {time: 1, dial: 1, date: 1};
  // Untouched, either way lays the clock out exactly as before its sizes could be set.
  const smallFont = {...measures, width: 244, digit: 57.6, foot: 67, dateWide: 920, dateTall: 94, dateTop: 55};
  for (const [long, short, m] of [[780, 360, measures], [735, 360, smallFont], [891, 411, measures], [640, 360, measures], [1280, 800, measures]]) {
    const font = Math.max(40, Math.min((long - 24) / m.width, (short - 216) / m.digit) * 100);
    const wide = Math.max(1, Math.min(1.3, (long - 24) / (m.width * font / 100)));
    const tall = Math.max(1, Math.min(1.3, (short - 216) / (m.digit * font / 100)));
    const date = Math.max(12, Math.min((long - 244) / m.dateWide, short * 0.17 / m.dateTall) * 100);
    for (const auto of [true, false]) {
      const got = layout(long, short, m, ones, auto), what = `${long}x${short} ${auto ? 'Auto' : 'Custom'}`;
      near(got.dial, 182, what + ' dial');
      near(got.date, date, what + ' date');
      near(got.time.font, font, what + ' time font');
      near(got.time.wide, wide, what + ' time stretch across');
      near(got.time.tall, tall, what + ' time stretch up');
      near(got.time.left, Math.max(0, (long - m.width * font / 100 * wide) / 2), what + ' time left');
      near(got.time.top, short - 12 - m.foot * font / 100 * tall, what + ' time top');
    }
  }
  // Auto: a larger dial takes room from the time and the date, a smaller one gives it back. (The time may go beside
  // a large dial, taller but narrower there; what it takes of the screen only ever shrinks as the dial grows.)
  const area = box => wideness(box) * tallness(box);
  const plain = layout(780, 360, measures, ones, true);
  const larger = layout(780, 360, measures, {...ones, dial: 1.4}, true);
  const smaller = layout(780, 360, measures, {...ones, dial: 0.6}, true);
  near(larger.dial, 182 * 1.4, 'larger dial');
  near(smaller.dial, 182 * 0.6, 'smaller dial');
  assert.ok(larger.date < plain.date && area(larger.rects.time) < area(plain.rects.time), 'a larger dial makes room');
  assert.ok(smaller.date > plain.date && tallness(smaller.rects.time) > tallness(plain.rects.time), 'a smaller dial gives room back');
  for (const [long, short] of [[780, 360], [891, 411], [640, 360]]) {
    let before = Infinity;
    for (let dial = 0.4; dial <= 2.2; dial += 0.05) {
      const now = area(layout(long, short, measures, {...ones, dial}, true).rects.time);
      assert.ok(now <= before + 0.5, `${long}x${short}: the time never grows as the dial grows (${dial.toFixed(2)})`);
      before = now;
    }
  }
  // The time's own size: hours, minutes and seconds together, in the same shape, still standing at the bottom.
  const halfTime = layout(780, 360, measures, {...ones, time: 0.5}, true);
  near(halfTime.time.font, plain.time.font / 2, 'half time');
  near(halfTime.time.wide, plain.time.wide, 'half time, same shape');
  near(halfTime.rects.time[3], 348, 'half time at the bottom');
  near(layout(780, 360, measures, {...ones, date: 0.5}, true).date, plain.date / 2, 'half date');
  // Never past what fits: in Auto the time and the date go up to 100 %, the dial up to the screen's height.
  const most = layout(780, 360, measures, {time: 3, dial: 9, date: 3}, true);
  assert.deepEqual(most.sizes, {time: 1, dial: most.limits.dial[1], date: 1});
  near(most.dial, 360 - 28, 'largest dial');
  assert.deepEqual(layout(780, 360, measures, {time: 0, dial: 0, date: 0}, true).sizes, {time: 0.3, dial: 0.4, date: 0.3});
  // With the dial as tall as the screen, the time goes beside it instead of under it.
  assert.ok(most.rects.time[2] <= most.rects.dial[0] && tallness(most.rects.time) > 60, 'the time beside a tall dial');
  // Whatever the sizes, nothing covers anything else and everything stays on the screen.
  for (const [long, short] of [[780, 360], [891, 411], [640, 360], [1280, 800], [735, 360]])
    for (const dial of [0.4, 0.7, 1, 1.3, 1.6, 2, 9]) for (const time of [0.3, 0.7, 1]) for (const date of [0.3, 1]) {
      const got = layout(long, short, measures, {time, dial, date}, true), r = got.rects, what = `Auto ${long}x${short} ${dial}/${time}/${date}`;
      for (const [name, box] of Object.entries(r)) assert.ok(within(box, long, short), `${what}: ${name} on the screen ${box}`);
      for (const [a, b] of [['dial', 'time'], ['dial', 'date'], ['dial', 'buttons'], ['date', 'time'], ['buttons', 'time'], ['buttons', 'date']])
        assert.ok(!covers(r[a], r[b]), `${what}: ${a} ${r[a].map(Math.round)} clear of ${b} ${r[b].map(Math.round)}`);
    }
  // Custom: each keeps its own size; a larger dial leaves the time and the date as they were.
  const own = layout(780, 360, measures, {...ones, dial: 1.5}, false);
  near(own.dial, 273, 'Custom dial');
  near(own.date, plain.date, 'Custom date untouched by the dial');
  near(own.time.font, plain.time.font, 'Custom time untouched by the dial');
  // The time already fills the width: larger, it grows taller (up to 1.3 times), smaller it keeps its shape.
  const tallerTime = layout(780, 360, measures, {...ones, time: 1.2}, false);
  near(tallness(tallerTime.rects.time), 1.2 * tallness(plain.rects.time), 'Custom taller time');
  near(wideness(tallerTime.rects.time), wideness(plain.rects.time), 'Custom taller time, same width');
  const smallerTime = layout(780, 360, measures, {...ones, time: 0.5}, false);
  near(smallerTime.time.font, plain.time.font / 2, 'Custom smaller time');
  near(smallerTime.time.wide, plain.time.wide, 'Custom smaller time, same shape');
  near(layout(780, 360, measures, {...ones, date: 1.3}, false).date, plain.date * 1.3, 'Custom larger date');
  const ownMost = layout(780, 360, measures, {time: 9, dial: 9, date: 9}, false);
  assert.deepEqual(ownMost.sizes, {time: ownMost.limits.time[1], dial: ownMost.limits.dial[1], date: ownMost.limits.date[1]});
  near(ownMost.limits.time[1], 1.3, 'Custom time limit');
  for (const [name, box] of Object.entries(ownMost.rects)) assert.ok(within(box, 780, 360), `Custom largest: ${name} on the screen ${box}`);

  // The gear and its bar, as the user works them.
  const sized = setup(stationFetcher([['TST', 'Test Station', 28, 77]]));
  const knob = sized.elements;
  assert.equal(knob['clock-sizes'].hidden, true);
  knob['clock-edit'].onclick();                       // not in full screen: nothing opens
  assert.equal(knob['clock-sizes'].hidden, true);
  knob['clock-full'].onclick();
  knob['clock-time'].onclick?.();                     // the clock itself changes nothing until the gear is pressed
  assert.equal(knob['clock-sizes'].hidden, true);
  knob['clock-edit'].onclick();
  assert.equal(knob['clock-sizes'].hidden, false);
  assert.equal(knob['size-time'].className, 'on');    // the time first, in Auto
  assert.equal(knob['size-auto'].className, 'on');
  assert.equal(knob['size-value'].textContent, '100%');
  knob['size-down'].onclick();
  assert.equal(knob['size-value'].textContent, '95%');
  knob['size-dial'].onclick();
  assert.equal(knob['size-dial'].className, 'on');
  assert.equal(knob['size-time'].className, '');
  assert.equal(knob['clock-sizes'].className, 'low');  // the bar keeps out of the way of what is being sized
  knob['size-up'].onclick();
  knob['size-up'].onclick();
  assert.equal(knob['size-value'].textContent, '110%');
  knob['clock-date'].onclick();                       // a tap on the date picks the date
  assert.equal(knob['size-date'].className, 'on');
  knob['size-custom'].onclick();                      // Custom has sizes of its own
  assert.equal(knob['size-custom'].className, 'on');
  assert.equal(knob['size-auto'].className, '');
  assert.equal(knob['size-value'].textContent, '100%');
  knob['size-up'].onclick();
  assert.equal(knob['size-value'].textContent, '105%');
  assert.deepEqual(JSON.parse(sized.store.get('safar-clock-sizes')),
    {mode: 'custom', auto: {time: 0.95, dial: 1.1, date: 1}, custom: {time: 1, dial: 1, date: 1.05}});
  knob['size-done'].onclick();
  assert.equal(knob['clock-sizes'].hidden, true);
  // Kept for the next start; "Reset" puts the sizes of the way in use back.
  const resized = setup(stationFetcher([['TST', 'Test Station', 28, 77]]), sized.store);
  const again = resized.elements;
  again['clock-full'].onclick();
  again['clock-edit'].onclick();
  assert.equal(again['size-custom'].className, 'on');
  again['size-date'].onclick();
  assert.equal(again['size-value'].textContent, '105%');
  again['size-reset'].onclick();
  assert.equal(again['size-value'].textContent, '100%');
  assert.deepEqual(JSON.parse(resized.store.get('safar-clock-sizes')),
    {mode: 'custom', auto: {time: 0.95, dial: 1.1, date: 1}, custom: ones});
  // EXIT closes the bar with the full-screen clock, and the dial goes back to its everyday size.
  again['clock-full'].onclick();
  assert.equal(again['clock-sizes'].hidden, true);
  assert.equal(again.body.className, '');
  assert.equal(again.speedo.style.width, '');

  // ---- Sizing like a picture. With the bar open, the part being sized sits in a dashed box with a handle at each
  // corner (top left, top right, bottom right, bottom left, in the clock's own measure). A corner drawn away from
  // where the part stands makes it larger, drawn towards it smaller, by how much farther or nearer the finger is; two
  // fingers spread or pinched anywhere on the clock do the same by how much farther apart they are.
  const fallback = {width: 305, digit: 71.1, foot: 84.5, dateWide: 1150, dateTall: 117, dateTop: 59, buttonsWide: 92};
  const drawn = setup(stationFetcher([['TST', 'Test Station', 28, 77]]), null, null, {innerWidth: 360, innerHeight: 735});
  const hand = drawn.elements;
  const keptSizes = () => JSON.parse(drawn.store.get('safar-clock-sizes'));
  const reach = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // The clock is turned: its left-to-right runs down the page, its top-to-bottom from the page's right edge.
  const onPage = ([u, v]) => ({clientX: 360 - v, clientY: u});
  hand['clock-full'].onclick();
  assert.equal(hand.body.className, 'clockmode turned');
  assert.equal(hand['size-box'].hidden, true);        // no box or handles until the gear is pressed
  assert.equal(hand['size-handle-0'].hidden, true);
  hand['clock-edit'].onclick();
  hand['size-dial'].onclick();
  assert.equal(hand['size-box'].hidden, false);
  for (let i = 0; i < 4; i++) assert.equal(hand[`size-handle-${i}`].hidden, false);
  const dialBox = drawn.context.clockLayout(735, 360, fallback, ones, true).rects.dial;
  near(parseFloat(hand['size-box'].style.left), dialBox[0] - 6, 'box round the dial, left');
  near(parseFloat(hand['size-box'].style.width), dialBox[2] - dialBox[0] + 12, 'box round the dial, width');
  const lowLeft = [dialBox[0] - 6, dialBox[3] + 6], dialCorner = [dialBox[2], dialBox[1]];
  near(parseFloat(hand['size-handle-3'].style.left), lowLeft[0], 'bottom left handle, across');
  near(parseFloat(hand['size-handle-3'].style.top), lowLeft[1], 'bottom left handle, down');
  // The dial stands in its top right corner: its bottom left corner drawn out makes it larger.
  const out = [lowLeft[0] - 40, lowLeft[1] + 40];
  hand['size-handle-3'].onpointerdown({pointerId: 7, ...onPage(lowLeft)});
  hand['size-handle-3'].onpointermove({pointerId: 7, ...onPage(out)});
  hand['size-handle-3'].onpointerup({pointerId: 7});
  const drawnOut = Math.round(reach(out, dialCorner) / reach(lowLeft, dialCorner) * 100) / 100;
  assert.ok(drawnOut > 1.2);
  near(keptSizes().auto.dial, drawnOut, 'a corner drawn out');
  // The handles moved with the larger dial; another finger on another handle, drawn in, makes it smaller again.
  const grown = drawn.context.clockLayout(735, 360, fallback, {...ones, dial: drawnOut}, true).rects.dial;
  near(parseFloat(hand['size-handle-0'].style.left), grown[0] - 6, 'top left handle follows the dial');
  const topLeft = [grown[0] - 6, grown[1] - 6], inward = [topLeft[0] + 60, topLeft[1]];
  hand['size-handle-0'].onpointerdown({pointerId: 8, ...onPage(topLeft)});
  hand['size-handle-0'].onpointermove({pointerId: 9, ...onPage([0, 0])});   // another finger's move is not this drag
  near(keptSizes().auto.dial, drawnOut, 'another finger does not drag');
  hand['size-handle-0'].onpointermove({pointerId: 8, ...onPage(inward)});
  hand['size-handle-0'].onpointerup({pointerId: 8});
  const drawnIn = Math.round(drawnOut * reach(inward, [grown[2], grown[1]]) / reach(topLeft, [grown[2], grown[1]]) * 100) / 100;
  assert.ok(drawnIn < drawnOut);
  near(keptSizes().auto.dial, drawnIn, 'a corner drawn in');
  // The time stands on the middle of its foot; the date in its top left corner.
  hand['size-time'].onclick();
  const timeBox = drawn.context.clockLayout(735, 360, fallback, {...ones, dial: drawnIn}, true).rects.time;
  near(parseFloat(hand['size-box'].style.top), timeBox[1] - 6, 'box round the time');
  hand['size-date'].onclick();
  const dateBox = drawn.context.clockLayout(735, 360, fallback, {...ones, dial: drawnIn}, true).rects.date;
  near(parseFloat(hand['size-box'].style.left), dateBox[0] - 6, 'box round the date');
  // Two fingers on the dial's size: pinched to half their distance apart, it halves; spread to twice, it doubles.
  // One finger alone changes nothing.
  hand['size-dial'].onclick();
  const body = hand.body;
  body.onpointerdown({pointerId: 1, clientX: 100, clientY: 300, target: body});
  body.onpointermove({pointerId: 1, clientX: 60, clientY: 300, target: body});
  near(keptSizes().auto.dial, drawnIn, 'one finger does not pinch');
  body.onpointerdown({pointerId: 2, clientX: 160, clientY: 300, target: body});
  body.onpointermove({pointerId: 2, clientX: 110, clientY: 300, target: body});   // 100 apart -> 50 apart
  body.onpointerup({pointerId: 2, target: body});
  body.onpointerup({pointerId: 1, target: body});
  near(keptSizes().auto.dial, Math.round(drawnIn / 2 * 100) / 100, 'pinched to half');
  const halved = keptSizes().auto.dial;
  body.onpointerdown({pointerId: 3, clientX: 100, clientY: 300, target: body});
  body.onpointerdown({pointerId: 4, clientX: 150, clientY: 300, target: body});
  body.onpointermove({pointerId: 4, clientX: 200, clientY: 300, target: body});  // 50 apart -> 100 apart
  body.onpointerup({pointerId: 3, target: body});
  body.onpointerup({pointerId: 4, target: body});
  near(keptSizes().auto.dial, Math.round(halved * 2 * 100) / 100, 'spread to twice');
  // Fingers on the bar or a handle are not a pinch.
  const onBar = {closest: selector => selector.includes('#clock-sizes') ? {} : null};
  body.onpointerdown({pointerId: 5, clientX: 100, clientY: 300, target: onBar});
  body.onpointerdown({pointerId: 6, clientX: 150, clientY: 300, target: body});
  body.onpointermove({pointerId: 6, clientX: 300, clientY: 300, target: body});
  body.onpointerup({pointerId: 5, target: onBar});
  body.onpointerup({pointerId: 6, target: body});
  near(keptSizes().auto.dial, Math.round(halved * 2 * 100) / 100, 'a finger on the bar is not a pinch');
  // With the bar closed, no box, no handles, and two fingers change nothing.
  hand['size-done'].onclick();
  assert.equal(hand['size-box'].hidden, true);
  assert.equal(hand['size-handle-2'].hidden, true);
  const closedSize = keptSizes().auto.dial;
  body.onpointerdown({pointerId: 10, clientX: 100, clientY: 300, target: body});
  body.onpointerdown({pointerId: 11, clientX: 150, clientY: 300, target: body});
  body.onpointermove({pointerId: 11, clientX: 300, clientY: 300, target: body});
  body.onpointerup({pointerId: 10, target: body});
  body.onpointerup({pointerId: 11, target: body});
  near(keptSizes().auto.dial, closedSize, 'no pinch with the bar closed');

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
  assert.deepEqual(labels('PRYJ').filter(label => /PRYJ/.test(label)), ['ALLAHABAD JN (ALD) — now Prayagraj Jn (PRYJ)']);
  assert.deepEqual(labels('DDU').filter(label => /\(DDU\)/.test(label)), ['MUGHAL SARAI JN (MGS) — now Deen Dayal Upadhyaya Jn (DDU)']);
  assert.deepEqual(labels('Baruna').filter(label => /\(BUE\)/.test(label)), ['BARUNA (BUE)']);
  assert.ok(labels('Deen Dayal Upadhyaya').includes('MUGHAL SARAI JN (MGS) — now Deen Dayal Upadhyaya Jn (DDU)'));
  assert.ok(labels('Baruna').every(label => !/OSM:/.test(label)));

  // No route chosen: the next station is the nearest one ahead in the direction of travel (Buxar towards DDU).
  const free = setup(async url => ({ok: true, json: async () => read(url)}));
  await flush();
  free.elements.start.onclick();
  const at = (lat, lon, t) => ({coords: {latitude: lat, longitude: lon, accuracy: 4, speed: 30}, timestamp: t});
  free.watches[0].success(at(25.5600, 83.9600, 100000));
  assert.match(free.elements.next.textContent, /shown once the train moves/);
  free.watches[0].success(at(25.5560, 83.9300, 200000));
  assert.match(free.elements.next.textContent, /Next station \(estimated from direction\): .+\), \d+\.\d\d km/);
  assert.doesNotMatch(free.elements.next.textContent, /BUXAR/);
  // ---- Everything the app shows is in English (its name, Suffer Sathi, aside): the page's text, placeholders and
  // labels, every message its script writes, and the native side's dialogs, toasts and notifications.
  const HINGLISH = new RegExp('\\b(' + ['karein', 'karo', 'kare', 'karke', 'karne', 'karna', 'kar', 'kiya', 'kiye', 'nahi',
    'nahin', 'hai', 'hain', 'mein', 'aur', 'abhi', 'pehle', 'baad', 'agla', 'agle', 'nazdiki', 'nazdeeki', 'safar', 'samay',
    'ghadi', 'tarikh', 'gola', 'shuru', 'antim', 'apna', 'raste', 'rasta', 'ruka', 'ruki', 'rukne', 'anumaan', 'disha',
    'dobara', 'pichla', 'pichle', 'naya', 'taiyar', 'koshish', 'chalu', 'chahiye', 'sakte', 'saka', 'sakti', 'jaisa',
    'lagbhag', 'khaali', 'khali', 'dhoondh', 'kholein', 'theek', 'bada', 'chhota', 'padhe', 'hua', 'hui', 'rahe', 'raha',
    'rahi', 'wali', 'wala', 'kuch', 'koi', 'sab', 'sabse', 'bina', 'zaroori', 'jis', 'jiska', 'uska', 'kiska', 'hata',
    'hatayein', 'hatane', 'badalne', 'badlein', 'likhein', 'likhkar', 'neeche', 'aayi', 'chunkar', 'chunein', 'chuna',
    'chunna', 'dekhein', 'mila', 'mili', 'jodein', 'joda', 'jodne', 'dabayein', 'banayein', 'banega', 'bana', 'gaya',
    'gayi', 'ho', 'ka', 'ki', 'ke', 'ko', 'se', 'tak', 'ya', 'yahi', 'phir', 'sahi', 'intezar', 'aasman', 'khule',
    'jayein', 'laga', 'hokar', 'jaana', 'chhod', 'paas', 'paar', 'dono', 'alag', 'ek', 'beech', 'doosra', 'liye',
    'sambhavit', 'nirdharit', 'purani', 'chhoot', 'chhooti', 'maangega', 'pushti', 'sawaal', 'aayega', 'poora', 'ab',
    'dein', 'dikhega', 'hoga', 'hogi', 'wahi', 'yeh', 'tha', 'thi', 'aaya', 'padh', 'paye', 'dabaiye', 'hue',
    'gola', 'rang', 'badal', 'kam', 'zaroorat', 'baaki', 'adhoora', 'aane', 'naam', 'bahut', 'jab', 'tab', 'kya', 'bhi',
    'sirf', 'apni', 'apne', 'upar', 'andar', 'zyada', 'thoda', 'pura', 'poori', 'dabakar', 'chalne', 'rukna', 'intezaar'].join('|') + ')\\b', 'i');
  // The texts in a script (JavaScript or Java): its strings and the text of its templates, with the strings inside
  // a template's ${...} too (read the same way), and not its comments or regular expressions.
  function texts(code) {
    const found = [];
    // Reads from i to the end, or (inner) to the } that closes a template's ${, and gives where it stopped.
    function scan(i, inner) {
      let before = 'operator', depth = 0;
      while (i < code.length) {
        const c = code[i], next = code[i + 1];
        if (c === '/' && next === '/') { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end; continue; }
        if (c === '/' && next === '*') { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue; }
        if (c === "'" || c === '"') {
          let text = '';
          for (i++; i < code.length && code[i] !== c; i++) text += code[i] === '\\' ? code[++i] : code[i];
          found.push(text);
          i++;
          before = 'value';
          continue;
        }
        if (c === '`') {
          let text = '';
          for (i++; i < code.length && code[i] !== '`'; i++) {
            if (code[i] === '\\') { text += code[++i]; continue; }
            if (code[i] === '$' && code[i + 1] === '{') { i = scan(i + 2, true); text += ' '; continue; }
            text += code[i];
          }
          found.push(text);
          i++;
          before = 'value';
          continue;
        }
        if (c === '/' && before !== 'value') {           // a regular expression: no value stands before it
          let inClass = false;
          for (i++; i < code.length && (code[i] !== '/' || inClass); i++) {
            if (code[i] === '\\') i++;
            else if (code[i] === '[') inClass = true;
            else if (code[i] === ']') inClass = false;
          }
          for (i++; /[a-z]/i.test(code[i] || ''); i++);
          before = 'value';
          continue;
        }
        if (inner && c === '{') { depth++; before = 'operator'; i++; continue; }
        if (inner && c === '}') { if (!depth) return i; depth--; before = 'value'; i++; continue; }
        if (/\s/.test(c)) { i++; continue; }
        if (/[\w$]/.test(c)) {
          let j = i;
          while (j < code.length && /[\w$]/.test(code[j])) j++;
          before = /^(return|typeof|case|in|of)$/.test(code.slice(i, j)) ? 'keyword' : 'value';
          i = j;
          continue;
        }
        before = c === ')' || c === ']' || c === '}' ? 'value' : 'operator';
        i++;
      }
      return i;
    }
    scan(0, false);
    return found;
  }
  const shown = [];
  const page = html.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>/g, '');
  for (const match of page.matchAll(/>([^<]+)</g)) shown.push(match[1]);
  for (const match of page.matchAll(/\b(?:placeholder|aria-label|title|alt)="([^"]*)"/g)) shown.push(match[1]);
  // Keys and file names (no spaces, with - . / or _) are not shown.
  const words = text => /\s/.test(text.trim()) || !/[-./_]/.test(text);
  for (const text of texts(script)) if (words(text)) shown.push(text);
  const nativeDir = require('path').join(__dirname, '..', 'android', 'app', 'src', 'main');
  const javaDir = require('path').join(nativeDir, 'java', 'com', 'railtrack', 'app');
  for (const file of fs.readdirSync(javaDir).filter(name => name.endsWith('.java')))
    for (const text of texts(fs.readFileSync(require('path').join(javaDir, file), 'utf8'))) if (words(text)) shown.push(text);
  for (const match of fs.readFileSync(require('path').join(nativeDir, 'res', 'values', 'strings.xml'), 'utf8').matchAll(/<string name="[^"]*">([^<]*)</g))
    shown.push(match[1]);
  assert.ok(shown.some(text => text.includes('Suffer Sathi')) && shown.length > 100, 'the texts are found');
  const inHinglish = shown.filter(text => HINGLISH.test(text));
  assert.deepEqual(inHinglish, [], 'text in Hinglish on the screen:\n' + inHinglish.join('\n'));
  console.log('Safar tracker checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
