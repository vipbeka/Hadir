// Staff Attendance: Leaflet map with the office geofence, live location
// (only while this screen is open), server-time clock, check-in/out and
// early-leave request. The SERVER re-validates everything (geofence,
// windows, closing time); the page only collects coordinates.
//
// State model (fixes the "check-out freezes" report):
//   * the map and the location watch are created ONCE per visit and kept
//     across check-in → check-out (no re-acquisition after a save);
//   * an operation is ready → submitting → success | failure, the button is
//     restored in `finally`, every server call has a timeout, and an
//     uncertain result (timeout / dropped connection) is resolved by
//     reading the day back before offering a retry;
//   * after a confirmed save the page updates in place (no reload).
import { h, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatTime, formatClock, formatMinutes, hhmm } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, chip, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, textarea, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { confirmDialog } from '../../ui/modal.js';
import { icon } from '../../ui/icons.js';

// Technical, adjustable settings.
export const GEO_TIMEOUT_MS = 15000;        // give up waiting for a location fix after 15 s
const FIX_MAX_AGE_MS = 30000;               // a reading older than this is re-confirmed before submitting
const LEAFLET = new URL('../../../vendor/leaflet-1.9.4/', import.meta.url).href;

let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = `${LEAFLET}leaflet.css`; document.head.append(css);
    const s = document.createElement('script'); s.src = `${LEAFLET}leaflet.js`; s.onload = () => resolve(window.L);
    s.onerror = () => { leafletPromise = null; reject(new Error('leaflet')); };
    document.head.append(s);
  });
  return leafletPromise;
}

export function distanceM(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// "HH:MM:SS" (24h) of a Date in a given IANA zone — for comparing with
// schedule values; display always goes through formatTime/formatClock.
function zonedHms(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: tz })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}:${p.second}`;
}

// "GMT+2" for the business zone at the current moment (never hard-coded)
function tzOffsetLabel(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Africa/Cairo', timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return (p.find((x) => x.type === 'timeZoneName')?.value || 'GMT').replace('GMT', 'GMT');
  } catch { return 'GMT+2'; }
}
const displayInitial = (me) => String((getLang() === 'ar' ? me?.full_name_ar : me?.full_name_en) || me?.full_name_ar || '').trim().charAt(0);

export async function renderAttendance(main, { me, registerCleanup }) {
  setDocumentTitle(t('att.title'));
  add(main, pageHeader({ chips: [chip(t('att.office'), { iconName: 'building' })], title: t('att.title'), subtitle: t('att.subtitle') }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);

  // ---------------------------------------------------------------- state
  let day = null; let offset = 0; let alive = true;
  let pos = null;                 // { lat, lng, accuracy, at }
  let geo = 'idle';               // idle | locating | ok | outside | low | timeout | denied | unavailable | unsupported | insecure
  let geoToken = 0; let watchId = null; let geoTimer = null;
  let inFlight = false; let opError = null;
  let map = null; let officeLayer = null; let youMarker = null; let youAccuracy = null; let fitted = false; let resizeObs = null;
  let clockTimer = null; let lastClosed = null;

  // persistent nodes (created once)
  const clock = h('output', { class: 'att-clock num' });
  const workedOut = h('output', { class: 'att-worked num' });
  const topArea = h('div', { class: 'att-top' });
  const statusArea = h('div', { class: 'stack stack--sm' });
  const mapEl = h('div', { class: 'att-map', role: 'img', 'aria-label': t('set.office') });
  const mapMsg = h('div', { class: 'att-map__msg', hidden: true });
  const accChip = h('div', { class: 'att-acc', hidden: true });
  const mapWrap = h('div', { class: 'att-map-wrap' }, mapEl, accChip, mapMsg);
  const geoStatus = h('div', { class: 'att-geo', role: 'status', 'aria-live': 'polite' });
  const actionArea = h('div', { class: 'stack stack--sm att-action' });
  const tzLabel = h('span', { class: 'att-tz' });
  const accTile = h('span', { class: 'tile__value' }, t('att.accWait'));
  const permTile = h('span', { class: 'tile__value' }, t('att.permAsk'));
  let permState = null;
  const windowsHost = h('div');
  const earlyHost = h('div');

  registerCleanup(() => {
    alive = false;
    stopLocate();
    clearInterval(clockTimer);
    resizeObs?.disconnect();
    window.removeEventListener('orientationchange', onResize);
    map?.remove(); map = null;
  });

  // ------------------------------------------------------------- loading
  async function load({ quiet = false } = {}) {
    try {
      const d = await api('my_day');
      if (!alive) return;
      day = d; offset = Date.parse(day.server_now) - Date.now();
      if (!quiet || !body.querySelector('.att-card')) buildLayout(); else refreshSections();
    } catch (err) {
      if (!alive || quiet) return;
      fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true,
        action: button({ label: t('common.retry'), onClick: () => load() }) }));
    }
  }

  const att = () => day?.attendance || null;
  const done = () => !!att()?.checked_out_at;
  const checkedIn = () => !!att()?.checked_in_at;
  const serverNow = () => new Date(Date.now() + offset);
  const closedNow = () => {
    if (!day?.check_in_closes_at) return false;
    return !!day.check_in_closed || zonedHms(serverNow(), day.timezone) >= String(day.check_in_closes_at).padEnd(8, ':00').slice(0, 8);
  };
  const needsLocation = () => !day?.holiday && !done() && (checkedIn() || (day.check_in_enabled && !closedNow()));

  function buildLayout() {
    if (day.holiday) {
      stopLocate();
      fill(body, emptyState({ iconName: 'calendar', title: t('home.holiday', { name: getLang() === 'ar' ? day.holiday.name_ar : day.holiday.name_en }), text: t('err.holiday') }));
      return;
    }
    const recenterBtn = button({ label: t('att.recenter'), variant: 'ghost', icon: 'crosshair', iconOnly: true, onClick: () => { fitted = false; showMe(true); } });
    fill(body,
      card({ body: [h('div', { class: 'att-time__head' },
        h('span', { class: 'att-live' }, h('span', { class: 'att-live__dot', 'aria-hidden': 'true' }), t('att.syncedTime')),
        h('span', { class: 'att-tz-wrap' }, icon('clock'), tzLabel)), topArea], className: 'att-time' }),
      statusArea,
      h('section', { class: 'card att-card' },
        h('div', { class: 'card__header' }, h('div', { class: 'card__head' }, h('span', { class: 'card__icon', 'aria-hidden': 'true' }, icon('target')),
          h('div', {}, h('h3', { class: 'card__title' }, t('att.geofence')), h('p', { class: 'card__subtitle' }, t('att.geofenceSub')))), recenterBtn),
        mapWrap, geoStatus),
      card({ className: 'att-guide', title: t('att.guide'), actions: h('span', { class: 'text-muted', 'aria-hidden': 'true' }, icon('shield')),
        body: h('div', { class: 'tile-grid' },
          h('div', { class: 'tile' }, h('span', { class: 'tile__label' }, icon('crosshair', { size: 'sm' }), ' ', t('att.accTile')), accTile),
          h('div', { class: 'tile' }, h('span', { class: 'tile__label' }, icon('mapPin', { size: 'sm' }), ' ', t('att.permTile')), permTile)) }),
      actionArea,
      card({ iconName: 'shield', title: t('att.secureTitle'), body: h('p', { class: 'text-sm text-muted' }, t('att.privacy')), className: 'att-secure' }),
      windowsHost, earlyHost);
    tzLabel.textContent = t('att.tzCairo', { off: tzOffsetLabel(day.timezone) });
    watchPermission();
    refreshSections();
    clearInterval(clockTimer); clockTimer = setInterval(tick, 1000); tick();
    if (needsLocation()) { ensureMap(); if (geo === 'idle') startLocate(); }
  }

  function refreshSections() {
    const a = att();
    fill(topArea,
      clock,
      a?.checked_in_at ? h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, t('att.worked')),
        a.checked_out_at ? h('span', { class: 'att-worked num' }, formatMinutes(a.worked_minutes)) : workedOut) : null);
    fill(statusArea,
      day.missing_checkouts > 0 ? alert(t('att.missingCheckout'), { tone: 'info' }) : null,
      a?.checked_in_at ? alert(a.checked_out_at
        ? `${t('home.checkedInAt', { time: formatTime(a.checked_in_at) })} · ${t('home.checkedOutAt', { time: formatTime(a.checked_out_at) })}`
        : t('home.checkedInAt', { time: formatTime(a.checked_in_at) }), { tone: a.checked_out_at ? 'success' : 'info' }) : null);
    fill(windowsHost, windowsCard());
    fill(earlyHost, earlyLeaveCard());
    mapWrap.hidden = !needsLocation(); geoStatus.hidden = !needsLocation();
    body.querySelector('.att-guide')?.toggleAttribute('hidden', !needsLocation());
    if (!needsLocation()) stopLocate();
    renderAction();
  }

  function tick() {
    if (!day) return;
    clock.textContent = formatTime(serverNow(), getLang(), { seconds: true });
    const a = att();
    if (a?.checked_in_at && !a.checked_out_at) workedOut.textContent = formatMinutes((serverNow() - new Date(a.checked_in_at)) / 60000);
    // #12: the page may stay open across the closing moment → re-evaluate
    const c = closedNow();
    if (c !== lastClosed) { lastClosed = c; refreshSections(); }
  }

  // ---------------------------------------------------------- action area
  function renderAction() {
    const a = att();
    if (a?.checked_out_at) { fill(actionArea); return; }
    if (!a?.checked_in_at && !day.check_in_enabled) { fill(actionArea, alert(t('err.check_in_disabled'), { tone: 'info' })); return; }
    if (!a?.checked_in_at && closedNow()) {
      fill(actionArea, alert(t('att.closed', { time: formatClock(day.check_in_closes_at) }), { tone: 'warning' }));
      return;
    }
    const isOut = !!a?.checked_in_at;
    const ready = geo === 'ok' && !!pos;
    const btn = button({ label: isOut ? t('att.checkOut') : t('att.checkIn'), variant: 'primary', size: 'lg', block: true, icon: 'checkCircle',
      onClick: () => submit(isOut ? 'check_out' : 'check_in') });
    btn.disabled = !ready || inFlight;
    if (inFlight) setLoading(btn, true, t('att.saving'));
    if (!ready && !inFlight) { btn.querySelector('.icon')?.replaceWith(icon(geo === 'outside' ? 'mapPinOff' : 'mapPin')); }
    fill(actionArea,
      opError ? alert(opError, { tone: 'danger' }) : null,
      btn,
      !ready && !inFlight ? h('p', { class: 'hint-line' }, icon('lock'), geo === 'outside' ? t('att.hintApproach') : t('att.needLocation')) : null);
  }

  // ------------------------------------------------------------- submit
  async function submit(kind) {
    if (inFlight) return;            // double-click / double-tap guard
    inFlight = true; opError = null; renderAction();
    const before = { in: att()?.checked_in_at || null, out: att()?.checked_out_at || null };
    try {
      const fix = await freshFix();
      const r = await api(kind, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
      applySuccess(kind, r);
    } catch (err) {
      if (['timeout', 'network', 'offline', 'server_error'].includes(err?.code)) {
        // Uncertain result: the save may have reached the server. Read the
        // day back BEFORE offering a retry, so we never double-submit.
        const back = await api('my_day').catch(() => null);
        const saved = back && (kind === 'check_in' ? back.attendance?.checked_in_at && !before.in
                                                   : back.attendance?.checked_out_at && !before.out);
        if (back && alive) { day = back; offset = Date.parse(back.server_now) - Date.now(); }
        if (saved) { applySuccess(kind, null); return; }
        opError = t('att.uncertain');
      } else if (err?.code === 'geo') {
        opError = err.message;
      } else {
        opError = errorMessage(err);
        if (['already_checked_in', 'already_checked_out', 'check_in_closed'].includes(err?.code)) load({ quiet: true });
      }
      toast({ title: t('error.title'), text: opError, tone: 'danger' });
    } finally {
      inFlight = false;
      if (alive && day) refreshSections();
    }
  }

  function applySuccess(kind, r) {
    if (!alive) return;
    const a = { ...(day.attendance || {}) };
    if (kind === 'check_in') {
      if (r) { a.checked_in_at = r.checked_in_at || serverNow().toISOString(); a.check_in_outcome = r.outcome; }
      if (!r || r.outcome === 'none') toast({ title: t('att.doneNone'), tone: 'success' });
      else if (r.outcome === 'green') toast({ title: t('att.doneGreen', { window: getLang() === 'ar' ? r.window_label_ar : r.window_label_en }), tone: 'success' });
      else toast({ title: t('att.doneRed', { warn: r.warning_only ? t('att.warnSuffix') : '' }), tone: 'warning' });
    } else {
      if (r) { a.checked_out_at = r.checked_out_at || serverNow().toISOString(); a.worked_minutes = r.worked_minutes; }
      toast({ title: r ? t('att.doneOut', { h: formatMinutes(r.worked_minutes) }) : t('att.savedConfirmed'), tone: 'success' });
    }
    if (r) day.attendance = a;
    opError = null;
    refreshSections();
    load({ quiet: true });            // sync with the server in the background
  }

  // --------------------------------------------------------- geolocation
  function stopLocate() {
    geoToken++;                       // invalidates callbacks from older requests
    if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    watchId = null; clearTimeout(geoTimer); geoTimer = null;
  }

  function startLocate() {
    stopLocate();
    const token = geoToken;
    if (!window.isSecureContext) { setGeo('insecure'); return; }
    if (!('geolocation' in navigator)) { setGeo('unsupported'); return; }
    pos = null; setGeo('locating');
    geoTimer = setTimeout(() => {
      if (token !== geoToken || pos) return;
      stopLocate(); setGeo('timeout');
    }, GEO_TIMEOUT_MS);
    watchId = navigator.geolocation.watchPosition((p) => {
      if (token !== geoToken || !alive) return;                 // stale callback after retry / page exit
      if (Date.now() - p.timestamp > FIX_MAX_AGE_MS * 2) return; // an old cached reading is not a new fix
      clearTimeout(geoTimer); geoTimer = null;
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
      evaluateFix();
    }, (e) => {
      if (token !== geoToken || !alive) return;
      if (pos && e.code !== 1) return;                          // keep the last good fix on a transient hiccup
      stopLocate();
      setGeo(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: GEO_TIMEOUT_MS });
  }

  function evaluateFix() {
    const office = { lat: Number(day.geofence.lat), lng: Number(day.geofence.lng) };
    const radius = Number(day.geofence.radius_m);
    const d = Math.round(distanceM(office, pos));
    if (pos.accuracy > radius) setGeo('low', { a: Math.round(pos.accuracy) });
    else if (d > radius) setGeo('outside', { d, r: radius });
    else setGeo('ok', { d, r: radius });
    showMe();
  }

  // A reading older than FIX_MAX_AGE_MS is re-confirmed right before submitting.
  function freshFix() {
    if (pos && Date.now() - pos.at <= FIX_MAX_AGE_MS && geo === 'ok') return Promise.resolve(pos);
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(Object.assign(new Error(t('att.unsupported')), { code: 'geo' })); return; }
      navigator.geolocation.getCurrentPosition((p) => {
        pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() };
        evaluateFix();
        if (geo === 'ok') resolve(pos);
        else reject(Object.assign(new Error(geoText()), { code: 'geo' }));
      }, (e) => reject(Object.assign(new Error(e.code === 1 ? t('att.denied') : e.code === 3 ? t('att.geoTimeout') : t('att.unavailable')), { code: 'geo' })),
      { enableHighAccuracy: true, maximumAge: 0, timeout: GEO_TIMEOUT_MS });
    });
  }

  let geoVars = {};
  function geoText() {
    return ({ locating: t('att.locating'), ok: t('att.verified'), outside: t('att.outside', geoVars), low: t('att.lowAccuracy', geoVars),
      timeout: t('att.geoTimeout'), denied: t('att.denied'), unavailable: t('att.unavailable'),
      unsupported: t('att.unsupported'), insecure: t('att.insecure') })[geo] || '';
  }
  function setGeo(state, vars = {}) {
    geo = state; geoVars = vars;
    const tone = state === 'ok' ? 'success' : state === 'locating' ? 'neutral' : ['low', 'timeout', 'unavailable'].includes(state) ? 'warning' : 'danger';
    const retry = ['timeout', 'unavailable', 'denied'].includes(state)
      ? button({ label: t('att.retryLocate'), size: 'sm', icon: 'mapPin', onClick: () => startLocate() }) : null;
    geoStatus.className = `att-geo att-geo--${tone}`;
    const nf = new Intl.NumberFormat('en-US');
    let main = geoText(); let detail = null;
    if (state === 'outside') { main = t('att.outsideTitle', { d: nf.format(vars.d) }); detail = t('att.outsideDetail', { r: nf.format(vars.r) }); }
    if (state === 'ok' && vars.d !== undefined) detail = t('att.insideDetail', { d: nf.format(vars.d), r: nf.format(vars.r) });
    fill(geoStatus,
      h('span', { class: 'att-geo__icon', 'aria-hidden': 'true' }, state === 'locating' ? h('span', { class: 'spinner' })
        : icon(state === 'ok' ? 'checkCircle' : tone === 'warning' ? 'alertTriangle' : 'alertCircle')),
      h('span', { class: 'att-geo__text' }, h('span', { class: 'att-geo__main' }, main), detail ? h('span', { class: 'att-geo__detail' }, detail) : null),
      retry);
    if (state === 'denied') permState = 'denied';
    updateTiles();
    renderAction();
  }

  // ---------------------------------------------------- guidance tiles
  function accQuality(m) { return m <= 20 ? t('att.accHigh') : m <= 60 ? t('att.accMid') : t('att.accLow'); }
  function updateTiles() {
    if (pos) {
      const m = Math.max(1, Math.round(pos.accuracy));
      accTile.textContent = `${accQuality(m)} · ${t('att.accValue', { m })}`;
      fill(accChip, h('span', { class: 'att-acc__dot', 'aria-hidden': 'true' }), t('att.gpsAcc', { q: accQuality(m), m }));
      accChip.hidden = false;
      accChip.dataset.q = m <= 20 ? 'high' : m <= 60 ? 'mid' : 'low';
    } else { accTile.textContent = geo === 'locating' ? t('att.accWait') : '—'; accChip.hidden = true; }
    const p = geo === 'denied' ? 'denied' : pos ? 'granted' : permState;
    permTile.textContent = p === 'granted' ? t('att.permOn') : p === 'denied' ? t('att.permOff') : t('att.permAsk');
    permTile.dataset.state = p || 'prompt';
  }
  function watchPermission() {
    navigator.permissions?.query({ name: 'geolocation' }).then((st) => {
      if (!alive) return;
      permState = st.state; updateTiles();
      st.onchange = () => { if (!alive) return; permState = st.state; updateTiles(); if (st.state === 'granted' && geo === 'denied') startLocate(); };
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ map
  function onResize() { map?.invalidateSize(); }
  function ensureMap() {
    if (map) { map.invalidateSize(); return; }
    loadLeaflet().then((L) => {
      if (!alive || map) return;
      const office = [Number(day.geofence.lat), Number(day.geofence.lng)];
      const css = getComputedStyle(document.documentElement);
      const accent = css.getPropertyValue('--color-accent').trim();
      map = L.map(mapEl, { zoomControl: true, attributionControl: true, maxZoom: 19 }).setView(office, 17);
      const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors' }).addTo(map);
      let ok = 0; let bad = 0;
      tiles.on('tileload', () => { ok++; mapMsg.hidden = true; });
      tiles.on('tileerror', () => {
        bad++;
        if (bad >= 4 && ok === 0) {
          fill(mapMsg, h('p', {}, t('att.mapFailed')), button({ label: t('common.retry'), size: 'sm', onClick: () => { bad = 0; mapMsg.hidden = true; tiles.redraw(); } }));
          mapMsg.hidden = false;
        }
      });
      const primary = css.getPropertyValue('--color-primary-text').trim();
      L.circle(office, { radius: Number(day.geofence.radius_m) * 1.6, stroke: false, fillColor: accent, fillOpacity: 0.07, interactive: false }).addTo(map);
      L.circle(office, { radius: Number(day.geofence.radius_m), color: primary, weight: 1.5, dashArray: '4 4', fillColor: accent, fillOpacity: 0.16 }).addTo(map);
      const officeHtml = document.createElement('div');
      officeHtml.append(h('span', { class: 'map-office__pin' }, icon('building')), h('span', { class: 'map-label' }, t('att.officeLabel')));
      officeLayer = L.marker(office, {
        title: t('att.officeLabel'), keyboard: false,
        icon: L.divIcon({ className: 'map-office', html: officeHtml, iconSize: [40, 40], iconAnchor: [20, 20] }),
      }).addTo(map);
      L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
      resizeObs = new ResizeObserver(() => map?.invalidateSize());
      resizeObs.observe(mapEl);
      window.addEventListener('orientationchange', onResize);
      setTimeout(() => map?.invalidateSize(), 50);
      showMe();
    }).catch(() => { fill(mapMsg, h('p', {}, t('att.mapError'))); mapMsg.hidden = false; });
  }

  function showMe(force = false) {
    if (!map || !window.L || !pos) { if (force && map) map.setView(officeLayer.getLatLng(), 17); return; }
    const L = window.L; const ll = [pos.lat, pos.lng];
    const css = getComputedStyle(document.documentElement);
    if (!youMarker) {
      youAccuracy = L.circle(ll, { radius: pos.accuracy, color: css.getPropertyValue('--color-point-red').trim(), weight: 1, fillOpacity: 0.06, interactive: false }).addTo(map);
      const youHtml = document.createElement('div');
      youHtml.append(h('span', { class: 'map-you__pin' }, (displayInitial(me) || '•')), h('span', { class: 'map-label map-label--you' }, t('att.youLabel')));
      youMarker = L.marker(ll, { title: t('att.youLabel'), keyboard: false, interactive: false,
        icon: L.divIcon({ className: 'map-you', html: youHtml, iconSize: [32, 32], iconAnchor: [16, 16] }) }).addTo(map);
    } else { youMarker.setLatLng(ll); youAccuracy.setLatLng(ll); youAccuracy.setRadius(pos.accuracy); }
    if (!fitted || force) {
      fitted = true;
      map.fitBounds(L.latLngBounds([officeLayer.getLatLng(), ll]).pad(0.35), { maxZoom: 18, animate: false });
    }
  }

  // ------------------------------------------------------- side sections
  function windowsCard() {
    const rows = (day.windows || []).map((w) => h('li', { class: ['win-row', w.green ? 'win-row--green' : 'win-row--none'] },
      h('span', { class: 'win-row__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'win-row__name' }, h('span', { class: 'win-row__label' }, getLang() === 'ar' ? w.label_ar : w.label_en),
        chip(w.green ? t('att.winGreen') : t('att.winNone'), { tone: w.green ? 'green' : 'neutral' })),
      h('span', { class: 'win-row__time num' }, h('span', {}, formatClock(w.start)), ' – ', h('span', {}, formatClock(w.end)))));
    return card({ iconName: 'calendar', title: t('att.windows'),
      actions: chip(t('att.endOfDay', { time: formatClock(day.expected_end_time) }), { iconName: 'clock', tone: 'neutral' }),
      body: [rows.length ? h('ul', { class: 'win-list', role: 'list' }, rows) : h('p', { class: 'text-sm text-muted' }, t('set.noWindows')),
        day.check_in_closes_at ? h('p', { class: 'hint-line' }, icon('lock'), t('att.closesAt', { time: formatClock(day.check_in_closes_at) })) : null] });
  }

  function earlyLeaveCard() {
    if (!day.is_work_day || done()) return null;
    const el = day.early_leave;
    if (el) {
      const cancel = button({ label: t('el.cancel'), size: 'sm', onClick: async () => {
        if (!(await confirmDialog({ title: t('el.cancel'), text: t('el.cancel'), variant: 'danger' }))) return;
        setLoading(cancel, true);
        try { await api('cancel_early_leave', { id: el.id }); toast({ title: t('req.cancelled'), tone: 'success' }); load({ quiet: true }); }
        catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
        finally { setLoading(cancel, false); }
      } });
      return card({ iconName: 'logOut', title: t('el.title'), actions: chip(t(`status.${el.status}`), { tone: el.status === 'approved' ? 'success' : 'neutral' }),
        body: h('p', {}, t('el.status', { time: formatClock(el.requested_leave_time), status: t(`status.${el.status}`) })), footer: [cancel] });
    }
    const fTime = input({ label: t('el.time'), type: 'time', required: true, attrs: { dir: 'ltr' } });
    fTime.querySelector('.field__label')?.after(chip(t('el.beforeEnd', { time: formatClock(day.work_end_time) }), { tone: 'neutral' }));
    const fReason = textarea({ label: t('common.reason'), rows: 3, placeholder: t('el.reasonPh') });
    fReason.querySelector('.field__label')?.after(chip(t('common.optional'), { tone: 'neutral' }));
    const ta = fReason.querySelector('textarea');
    const quick = h('div', { class: 'cluster cluster--sm' }, ['el.q1', 'el.q2', 'el.q3'].map((k) =>
      h('button', { type: 'button', class: 'chip chip--neutral chip--btn', onClick: () => { ta.value = t(k); ta.focus(); } }, t(k))));
    const send = button({ label: t('el.send'), variant: 'primary', size: 'lg', block: true, icon: 'send', type: 'submit' });
    let sending = false;
    const form = h('form', { class: 'stack', novalidate: true, onSubmit: async (e) => {
      e.preventDefault();
      if (sending) return;
      const v = fTime.querySelector('input').value;
      if (!v) { setFieldError(fTime, t('err.invalid_time')); return; }
      setFieldError(fTime, null); sending = true; setLoading(send, true);
      try { await api('request_early_leave', { leave_time: v, reason: ta.value }); toast({ title: t('el.sent'), tone: 'success' }); load({ quiet: true }); }
      catch (err) { setFieldError(fTime, errorMessage(err)); }
      finally { sending = false; setLoading(send, false); }
    } }, fTime, fReason, quick, send);
    return card({ iconName: 'logOut', title: t('el.title'), actions: chip(t('el.notify'), { tone: 'neutral' }), body: form, className: 'el-card' });
  }

  load();
}

// test hook
export const __test = { zonedHms, hhmm };
