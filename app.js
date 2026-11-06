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
function findRoutes() {
  const a = $("from").dataset.code, b = $("to").dataset.code;
  if (!a || !b || a === b) return;
  const r = rows(`SELECT x.route_id, rs.route_name, x.sequence_order AS s1, y.sequence_order AS s2
    FROM subroute_stations x
    JOIN subroute_stations y ON x.route_id = y.route_id AND y.sequence_order <> x.sequence_order
    JOIN rail_subroutes rs ON rs.route_id = x.route_id
    WHERE x.station_code = ? AND y.station_code = ?`, [a, b]);
  const sel = $("routes");
  sel.innerHTML = "";
  r.forEach((x, i) => sel.add(new Option(`${x.route_name} (${Math.abs(x.s2 - x.s1) + 1} stations)`, i)));
  sel.hidden = !r.length;
  sel._r = r;
  $("start").hidden = !r.length;
  if (r.length) showTimeline(r[0]);
  else { chain = []; $("timeline").innerHTML = "<li>No route found</li>"; }
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
    `<li class="${i < nextIdx ? "done" : i === nextIdx ? "next" : ""}">${esc(s.name)} <small>${esc(s.code)}</small></li>`).join("");
}
$("routes").onchange = e => showTimeline(e.target._r[e.target.value]);
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

// Native app: background-geolocation plugin (foreground service). Browser: navigator.geolocation.
async function startLocation(onFix, onError) {
  const BG = window.Capacitor?.isNativePlatform?.() && Capacitor.registerPlugin("BackgroundGeolocation");
  if (BG) {
    const id = await BG.addWatcher({
      backgroundTitle: "RailTrack",
      backgroundMessage: "Tracking your train journey",
      requestPermissions: true, stale: false, distanceFilter: 0,
    }, (loc, err) => {
      if (err) return onError(err.code === "NOT_AUTHORIZED" ? "Location permission denied" : err.message);
      onFix({ lat: loc.latitude, lon: loc.longitude, speedMs: loc.speed });
    });
    return () => BG.removeWatcher({ id });
  }
  const id = navigator.geolocation.watchPosition(
    p => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, speedMs: p.coords.speed }),
    e => onError(e.message), { enableHighAccuracy: true, maximumAge: 1000 });
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  return () => navigator.geolocation.clearWatch(id);
}

$("start").onclick = async () => {
  if (!chain.length) return;
  engine?.stop();
  await stopLocation?.();
  engine = new GeofenceEngine(chain, {
    onDistance: (s, d, v) => $("status").textContent = `Next: ${s.name} — ${Math.round(d)} m, ${v.toFixed(0)} km/h`,
    onArrival: s => $("status").textContent = `ARRIVED ${s.name}`,
    onTick: (s, ms) => $("status").textContent = `Halt at ${s.name}: ${dur(ms)}`,
    onDeparture: (s, a, d, ms) => {
      db.run("INSERT INTO trips(station_code,station_name,arrival,departure,halt_ms) VALUES(?,?,?,?,?)",
        [s.code, s.name, a, d, ms]);
      renderLog(); renderTimeline(engine.idx);
    },
  });
  renderTimeline(0);
  stopLocation = await startLocation(fix => engine.update(fix), m => $("status").textContent = m);
  $("stop").hidden = false;
};
$("stop").onclick = async () => {
  await stopLocation?.(); stopLocation = null; engine?.stop(); wakeLock?.release();
  $("status").textContent = "Stopped";
};
