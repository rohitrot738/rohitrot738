import { GeofenceEngine, haversine } from "./geofence.js";
const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } };
const d = haversine(28.6430, 77.2197, 27.4800, 77.6800);
assert(d > 130000 && d < 140000, "haversine " + d);
const ev = [];
const e = new GeofenceEngine([{ code: "A", name: "A", lat: 10, lon: 10 }], {
  onArrival: () => ev.push("arr"), onDeparture: () => ev.push("dep"),
});
e.update({ lat: 10.01, lon: 10, speedMs: 1 });
assert(!ev.length, "no early arrival");
e.update({ lat: 10.001, lon: 10, speedMs: 2 });
assert(ev[0] === "arr", "arrival");
e.update({ lat: 10.0041, lon: 10, speedMs: 1 });
assert(ev.length === 1, "no departure when slow");
e.update({ lat: 10.005, lon: 10, speedMs: 10 });
assert(ev[1] === "dep", "departure");
e.stop(); console.log("ok");
