import { GeofenceEngine } from "./geofence.js";

const $ = id => document.getElementById(id);
const fmt = t => t ? new Date(t).toLocaleTimeString() : "";
const dur = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m ${s % 60}s`; };
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const SQL = await initSqlJs({ locateFile: f => `vendor/${f}` });
const buf = await (await fetch("indian_railways_complete.db")).arrayBuffer();
const db = new SQL.Database(new Uint8Array(buf));
db.run(`CREATE TABLE IF NOT EXISTS trips(id INTEGER PRIMARY KEY AUTOINCREMENT, station_code TEXT,
  station_name TEXT, arrival INTEGER, departure INTEGER, halt_ms INTEGER)`);
// The trip table is persisted to localStorage and restored on load.
for (const r of JSON.parse(localStorage.getItem("trips") || "[]"))
  db.run("INSERT INTO trips(station_code,station_name,arrival,departure,halt_ms) VALUES(?,?,?,?,?)", r);

const rows = (sql, p = []) => {
  const st = db.prepare(sql); st.bind(p);
  const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out;
};

function autocomplete(input, dd) {
  input.addEventListener("input", () => {
    const q = input.value.trim();
    input.dataset.code = "";
    if (!q) { dd.hidden = true; return; }
    const res = rows(`SELECT station_code AS code, station_name AS name FROM stations
      WHERE station_name LIKE ? OR station_code LIKE ?
      ORDER BY (station_code = ?) DESC, station_name LIMIT 20`, [`%${q}%`, `${q}%`, q.toUpperCase()]);
    dd.innerHTML = "";
    res.forEach(s => {
      const d = document.createElement("div");
      d.textContent = `${s.name} (${s.code})`;
      d.onclick = () => { input.value = d.textContent; input.dataset.code = s.code; dd.hidden = true; findRoutes(); };
      dd.append(d);
    });
    dd.hidden = !res.length;
  });
}

let chain = [];
let graph;

function loadGraph() {
  graph = new Map();
  for (const l of rows("SELECT station_a, station_b, distance_km FROM station_links")) {
    for (const [x, y] of [[l.station_a, l.station_b], [l.station_b, l.station_a]]) {
      if (!graph.has(x)) graph.set(x, []);
      graph.get(x).push([y, l.distance_km]);
    }
  }
}

// Dijkstra over the station graph with a binary min-heap. Returns station codes and km.
function shortestPath(a, b) {
  if (!graph) loadGraph();
  const dist = new Map([[a, 0]]), prev = new Map(), heap = [[0, a]];
  const push = it => {
    heap.push(it);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        let m = i; const l = 2 * i + 1, r = l + 1;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === b) {
      const codes = [b];
      while (codes[0] !== a) codes.unshift(prev.get(codes[0]));
      return { codes, km: d };
    }
    if (d > dist.get(u)) continue;
    for (const [v, w] of graph.get(u) || []) {
      if (!dist.has(v) || d + w < dist.get(v)) { dist.set(v, d + w); prev.set(v, u); push([d + w, v]); }
    }
  }
  return null;
}

function stationsByCodes(codes) {
  const m = new Map(rows(`SELECT station_code AS code, station_name AS name, latitude AS lat, longitude AS lon
    FROM stations WHERE station_code IN (${codes.map(() => "?").join(",")})`, codes).map(s => [s.code, s]));
  return codes.map(c => m.get(c));
}

function findRoutes() {
  const a = $("from").dataset.code, b = $("to").dataset.code;
  if (!a || !b || a === b) return;
  const options = [];
  const path = shortestPath(a, b);
  if (path) options.push({ label: `Shortest path (${path.codes.length} stations, ${Math.round(path.km)} km)`, codes: path.codes });
  // Named lines that contain both stations, as alternatives.
  for (const x of rows(`SELECT x.route_id, rs.route_name, x.sequence_order AS s1, y.sequence_order AS s2
    FROM subroute_stations x
    JOIN subroute_stations y ON x.route_id = y.route_id AND y.sequence_order <> x.sequence_order
    JOIN rail_subroutes rs ON rs.route_id = x.route_id
    WHERE x.station_code = ? AND y.station_code = ?
    ORDER BY ABS(x.sequence_order - y.sequence_order) LIMIT 20`, [a, b]))
    options.push({ label: `${x.route_name} (${Math.abs(x.s2 - x.s1) + 1} stations)`, route: x });
  const sel = $("routes");
  sel.innerHTML = "";
  options.forEach((o, i) => sel.add(new Option(o.label, i)));
  sel.hidden = options.length < 2;
  sel._o = options;
  $("start").hidden = !options.length;
  if (options.length) showOption(options[0]);
  else { chain = []; $("timeline").innerHTML = "<li>No route found</li>"; }
}
function showOption(o) {
  if (o.codes) { chain = stationsByCodes(o.codes); renderTimeline(0); }
  else showTimeline(o.route);
}
function showTimeline({ route_id, s1, s2 }) {
  const lo = Math.min(s1, s2), hi = Math.max(s1, s2);
  chain = rows(`SELECT s.station_code AS code, s.station_name AS name, s.latitude AS lat, s.longitude AS lon
    FROM subroute_stations r JOIN stations s ON s.station_code = r.station_code
    WHERE r.route_id = ? AND r.sequence_order BETWEEN ? AND ?
    ORDER BY r.sequence_order ${s1 > s2 ? "DESC" : "ASC"}`, [route_id, lo, hi]);
  renderTimeline(0);
}
function renderTimeline(nextIdx) {
  $("timeline").innerHTML = chain.map((s, i) =>
    `<li class="${i < nextIdx ? "done" : i === nextIdx ? "next" : ""}">${esc(s.name)} <small>${esc(s.code)}</small><b class="dist"></b></li>`).join("");
}
$("routes").onchange = e => showOption(e.target._o[e.target.value]);
autocomplete($("from"), $("fromDd"));
autocomplete($("to"), $("toDd"));

function renderLog() {
  $("log").innerHTML = rows("SELECT * FROM trips ORDER BY id DESC LIMIT 50").map(t =>
    `<tr><td>${esc(t.station_name)}</td><td>${fmt(t.arrival)}</td><td>${fmt(t.departure)}</td><td>${dur(t.halt_ms)}</td></tr>`).join("");
  const all = rows("SELECT station_code,station_name,arrival,departure,halt_ms FROM trips ORDER BY id")
    .map(r => [r.station_code, r.station_name, r.arrival, r.departure, r.halt_ms]);
  localStorage.setItem("trips", JSON.stringify(all));
}
renderLog();

$("csv").onclick = () => {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["station_code,station_name,arrival,departure,halt_seconds"];
  for (const t of rows("SELECT * FROM trips ORDER BY id"))
    lines.push([t.station_code, t.station_name, new Date(t.arrival).toISOString(),
      new Date(t.departure).toISOString(), Math.round(t.halt_ms / 1000)].map(q).join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = "trip_log.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

let stopLocation, engine, wakeLock;
const setText = (id, t) => { $(id).textContent = t; };

// Native app: background-geolocation plugin (foreground service). Falls back to the web
// Geolocation API if the plugin errors, returns empty coordinates, or gives no fix in time.
async function startLocation(onFix, onStatus) {
  const cleanups = [];
  let gotFix = false, webStarted = false, timer;
  const fix = (lat, lon, speedMs, accuracy) => {
    if (lat == null || lon == null) return false;
    gotFix = true;
    onFix({ lat, lon, speedMs, accuracy });
    return true;
  };
  const startWeb = async reason => {
    if (webStarted) return;
    webStarted = true;
    onStatus(`GPS: Searching... (${reason})`);
    if (!navigator.geolocation) return onStatus("GPS: not supported on this device");
    const id = navigator.geolocation.watchPosition(
      p => fix(p.coords.latitude, p.coords.longitude, p.coords.speed, p.coords.accuracy),
      e => onStatus(`GPS error: ${e.message}`), { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
    cleanups.push(() => navigator.geolocation.clearWatch(id));
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  };

  onStatus("GPS: Searching...");
  const BG = window.Capacitor?.isNativePlatform?.() && Capacitor.registerPlugin("BackgroundGeolocation");
  if (BG) {
    try {
      // requestPermissions makes the plugin ask for fine/coarse location before starting.
      const id = await BG.addWatcher({
        backgroundTitle: "RailTrack",
        backgroundMessage: "Tracking your train journey",
        requestPermissions: true, stale: false, distanceFilter: 0,
      }, (loc, err) => {
        if (err) {
          if (err.code === "NOT_AUTHORIZED") {
            onStatus('Location permission denied. Open app settings, choose Location → "Allow all the time".');
            if (confirm("Location permission is needed. Open app settings?")) BG.openSettings();
          } else onStatus(`Native GPS error: ${err.message}`);
          return startWeb("native error");
        }
        if (!fix(loc?.latitude, loc?.longitude, loc?.speed, loc?.accuracy)) startWeb("empty coordinates");
      });
      cleanups.push(() => BG.removeWatcher({ id }));
      timer = setTimeout(() => { if (!gotFix) startWeb("no native fix after 20 s"); }, 20000);
    } catch (e) {
      onStatus(`Native GPS failed: ${e.message || e}`);
      await startWeb("native failed");
    }
  } else {
    await startWeb("browser");
  }
  return () => { clearTimeout(timer); cleanups.forEach(f => f()); };
}

function markNext(i) {
  document.querySelectorAll("#timeline li").forEach((li, k) => {
    li.classList.toggle("next", k === i);
    li.classList.toggle("done", k < i);
    li.classList.remove("here");
    li.querySelector(".dist").textContent = "";
  });
}

$("start").onclick = async () => {
  try {
    if (!chain.length) return setText("gps", "Pick origin and destination first");
    engine?.stop();
    await stopLocation?.();
    stopLocation = null;
    setText("speed", "Current Speed: 0 km/h");
    setText("acc", "Accuracy: --");
    setText("status", "");
    engine = new GeofenceEngine(chain, {
      onDistance: (s, d, v) => {
        setText("speed", `Current Speed: ${v.toFixed(0)} km/h`);
        const el = document.querySelector("#timeline li.next .dist");
        if (el) el.textContent = ` ${d >= 1000 ? (d / 1000).toFixed(1) + " km" : Math.round(d) + " m"}`;
        setText("status", `Next: ${s.name}`);
      },
      onArrival: s => {
        const li = document.querySelector("#timeline li.next");
        li?.classList.remove("next");
        li?.classList.add("here");
        setText("status", `ARRIVED ${s.name}`);
      },
      onTick: (s, ms) => setText("status", `Halt at ${s.name}: ${dur(ms)}`),
      onDeparture: (s, a, d, ms) => {
        db.run("INSERT INTO trips(station_code,station_name,arrival,departure,halt_ms) VALUES(?,?,?,?,?)",
          [s.code, s.name, a, d, ms]);
        renderLog();
        markNext(engine.idx);
      },
    });
    renderTimeline(0);
    $("stop").hidden = false;
    stopLocation = await startLocation(fix => {
      setText("gps", "GPS: Fix acquired");
      if (fix.accuracy != null) setText("acc", `Accuracy: ±${Math.round(fix.accuracy)} meters`);
      engine.update(fix);
    }, m => setText("gps", m));
  } catch (e) {
    setText("gps", `Could not start tracking: ${e.message || e}`);
  }
};
$("stop").onclick = async () => {
  await stopLocation?.(); stopLocation = null; engine?.stop(); wakeLock?.release();
  setText("gps", "GPS: Stopped");
};
