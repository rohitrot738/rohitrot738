const R = 6371000;
const rad = d => d * Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const ARRIVE_M = 400, DEPART_M = 450, ARRIVE_KMH = 15, DEPART_KMH = 15;

// Tracks stops along an ordered station list. Callbacks: onDistance, onArrival, onTick, onDeparture.
export class GeofenceEngine {
  constructor(stations, cb) {
    this.stations = stations; this.idx = 0; this.arrival = null; this.cb = cb;
    this.timer = null; this.lastPos = null;
  }
  get next() { return this.stations[this.idx]; }

  update({ lat, lon, speedMs }) {
    const st = this.next;
    if (!st) return;
    let kmh = speedMs == null ? null : speedMs * 3.6;
    // Fall back to speed derived from consecutive fixes when GPS gives none.
    if (kmh == null && this.lastPos) {
      const dt = (Date.now() - this.lastPos.t) / 3600000;
      if (dt > 0) kmh = haversine(this.lastPos.lat, this.lastPos.lon, lat, lon) / 1000 / dt;
    }
    this.lastPos = { lat, lon, t: Date.now() };
    if (kmh == null) kmh = 0;
    const d = haversine(lat, lon, st.lat, st.lon);
    this.cb.onDistance?.(st, d, kmh);

    if (!this.arrival && d < ARRIVE_M && kmh < ARRIVE_KMH) {
      this.arrival = Date.now();
      this.timer = setInterval(() => this.cb.onTick?.(st, Date.now() - this.arrival), 1000);
      this.cb.onArrival?.(st, this.arrival);
    } else if (this.arrival && d > DEPART_M && kmh > DEPART_KMH) {
      clearInterval(this.timer);
      const arrival = this.arrival;
      const dep = Date.now();
      this.arrival = null; this.idx++;
      this.cb.onDeparture?.(st, arrival, dep, dep - arrival);
    }
  }
  stop() { clearInterval(this.timer); }
}
