const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(fetch, saved, capacitor = null) {
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
  const context = {document, localStorage, navigator: {geolocation}, window: {Capacitor: capacitor}, fetch, AbortController, setTimeout, clearTimeout,
    console, Date, Math, Number, JSON, Blob, URL, confirm: () => true};
  vm.runInNewContext(script, context);
  return {elements, store, watches};
}

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
  assert.match(app.elements['network-status'].textContent, /90 have candidate links of 8,702 app stations/);
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
  assert.equal(JSON.parse(native.store.get('trainlog'))[0].name, 'Native Station');
  native.elements.stop.onclick();
  await flush();
  assert.equal(removedNativeWatcher, true);

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

  const inaccurate = setup(stationFetcher([['TST', 'Test Station', 28, 77]]));
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

  const legacyOffline = setup(async () => { throw new Error('offline'); }, [
    ['safar-stations-v1', JSON.stringify([['OLD', 'Cached Station', 28, 77]])]
  ]);
  legacyOffline.elements.start.onclick();
  legacyOffline.watches[0].success(fix(28, 100000));
  await flush();
  assert.match(legacyOffline.elements.now.textContent, /Cached Station/);
  assert.match(legacyOffline.elements['data-status'].textContent, /Saved station list available/);

  const database = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'stations.json'), 'utf8'));
  assert.equal(database.length, 8702);
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
  assert.match(routed.elements['route-status'].textContent, /OSM track-based candidate/);
  assert.deepEqual(routed.elements['route-list'].children.map(child => child.textContent), ['SON NAGAR (SEB)', 'DEHRI ON SONE (DOS)']);
  routed.elements.start.onclick();
  routed.watches[0].success({coords: {latitude: 24.9, longitude: 84.208, accuracy: 4, speed: 10}, timestamp: 100000});
  assert.match(routed.elements.next.textContent, /Sambhavit agla station: DEHRI ON SONE \(DOS\)/);
  routed.watches[0].success({coords: {latitude: 24.909345, longitude: 84.192214, accuracy: 4, speed: 10}, timestamp: 160000});
  routed.watches[0].success({coords: {latitude: 24.914895, longitude: 84.185434, accuracy: 4, speed: 10}, timestamp: 220000});
  assert.doesNotMatch(routed.store.get('trainlog') || '', /ADSR/);
  routed.watches[0].success({coords: {latitude: 25.5, longitude: 85, accuracy: 4, speed: 10}, timestamp: 280000});
  assert.match(routed.elements.next.textContent, /milan nahi hua/);
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
  assert.match(osmRoute.elements['route-status'].textContent, /OSM track-based candidate/);
  assert.deepEqual(osmRoute.elements['route-list'].children.map(child => child.textContent),
    ['OSM Alpha (OSM:77)', 'OSM Beta (OSM:78)']);

  const badRoute = setup(async url => url === 'osm-station-routes.json'
    ? {ok: true, json: async () => ({schema_version: 1, stations_unreviewed: true, edges: [['A','B',100]]})}
    : stationFetcher([['A','A',28,77],['B','B',29,77],['C','C',30,77]])(url));
  await flush();
  badRoute.elements.origin.value = 'A';
  badRoute.elements.destination.value = 'C';
  await badRoute.elements['find-route'].onclick();
  assert.match(badRoute.elements['route-status'].textContent, /OSM track candidate route nahi mila/);
  console.log('Safar tracker checks passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
