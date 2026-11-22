// Staff Attendance: Leaflet map with the office geofence, live location
// (only while this screen is open), server-time clock, check-in/out and
// early-leave request. The server re-validates everything.
import { h, clear, add, fill } from '../../core/dom.js';
import { t, setDocumentTitle, getLang } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatTime, formatMinutes, hhmm } from '../../core/format.js';
import { pageHeader } from '../../shell/shell.js';
import { card, badge, alert, emptyState, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { input, textarea, setFieldError } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { confirmDialog } from '../../ui/modal.js';
import { icon } from '../../ui/icons.js';

const LEAFLET = new URL('../../../vendor/leaflet-1.9.4/', import.meta.url).href;
let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = `${LEAFLET}leaflet.css`; document.head.append(css);
    const s = document.createElement('script'); s.src = `${LEAFLET}leaflet.js`; s.onload = () => resolve(window.L); s.onerror = reject;
    document.head.append(s);
  });
  return leafletPromise;
}

function distanceM(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export async function renderAttendance(main, { me, registerCleanup }) {
  setDocumentTitle(t('att.title'));
  add(main, pageHeader({ title: t('att.title'), subtitle: t('att.subtitle') }));
  const body = h('div', { class: 'stack' }, skeletonCard(t('common.loading')));
  add(main, body);

  let day; let watchId = null; let timer = null; let pos = null; let map = null; let youMarker = null; let offset = 0;
  registerCleanup(() => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    clearInterval(timer);
    map?.remove();
  });

  async function load() {
    try { day = await api('my_day'); } catch (err) {
      fill(body, emptyState({ iconName: 'alertTriangle', title: t('error.title'), text: errorMessage(err), error: true,
        action: button({ label: t('common.retry'), onClick: load }) }));
      return;
    }
    offset = Date.parse(day.server_now) - Date.now();
    render();
  }

  function render() {
    clear(body);
    const a = day.attendance;
    const office = { lat: Number(day.geofence.lat), lng: Number(day.geofence.lng) };
    const radius = Number(day.geofence.radius_m);
    const clock = h('output', { class: 'att-clock num', dir: 'ltr' });
    const worked = h('output', { class: 'att-worked num' });
    const tick = () => {
      const now = new Date(Date.now() + offset);
      clock.textContent = new Intl.DateTimeFormat(getLang() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: day.timezone }).format(now);
      if (a?.checked_in_at && !a.checked_out_at) worked.textContent = formatMinutes((now - new Date(a.checked_in_at)) / 60000);
    };
    clearInterval(timer); timer = setInterval(tick, 1000); tick();

    // ---------- status / blocked days
    if (day.holiday) {
      add(body, emptyState({ iconName: 'calendar', title: t('home.holiday', { name: getLang() === 'ar' ? day.holiday.name_ar : day.holiday.name_en }), text: t('err.holiday') }));
      return;
    }
    const mapEl = h('div', { class: 'att-map', role: 'img', 'aria-label': t('set.office') });
    const geoStatus = h('div', { class: 'att-geo', role: 'status', 'aria-live': 'polite' }, icon('mapPin'), h('span', {}, t('att.locating')));
    const actionBtn = button({ label: a?.checked_in_at ? t('att.checkOut') : t('att.checkIn'), variant: 'primary', size: 'lg', block: true, icon: 'checkCircle',
      attrs: { disabled: true }, onClick: submit });
    actionBtn.disabled = true;
    const done = a?.checked_out_at;

    add(body, 
      card({ body: h('div', { class: 'att-top' },
        h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, t('att.serverTime')), clock),
        a?.checked_in_at ? h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, t('att.worked')),
          a.checked_out_at ? h('span', { class: 'att-worked num' }, formatMinutes(a.worked_minutes)) : worked) : null) }),
      day.missing_checkouts > 0 ? alert(t('att.missingCheckout'), { tone: 'info' }) : null,
      h('section', { class: 'card att-card' }, mapEl, geoStatus,
        done ? alert(`${t('home.checkedInAt', { time: formatTime(a.checked_in_at) })} · ${t('home.checkedOutAt', { time: formatTime(a.checked_out_at) })}`, { tone: 'success' })
          : (!day.check_in_enabled && !a ? alert(t('err.check_in_disabled'), { tone: 'info' }) : actionBtn),
        h('p', { class: 'text-xs text-muted' }, t('att.privacy'))),
      windowsCard(), earlyLeaveCard());

    if (done || (!day.check_in_enabled && !a)) return;

    // ---------- map (optional: attendance works without it)
    loadLeaflet().then((L) => {
      map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([office.lat, office.lng], 17);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
      L.circle([office.lat, office.lng], { radius, color: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(), weight: 2, fillOpacity: 0.12 }).addTo(map);
      L.marker([office.lat, office.lng], { title: 'Zintra' }).addTo(map);
      if (pos) showMe();
    }).catch(() => mapEl.replaceChildren(alert(t('att.mapError'), { tone: 'info' })));

    function showMe() {
      if (!map || !window.L || !pos) return;
      const ll = [pos.lat, pos.lng];
      if (!youMarker) youMarker = window.L.circleMarker(ll, { radius: 8, color: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(), weight: 2, fillColor: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(), fillOpacity: 1 }).addTo(map);
      else youMarker.setLatLng(ll);
    }

    // ---------- geolocation (only while this screen is open)
    if (!('geolocation' in navigator)) { setGeo('danger', t('att.unsupported')); return; }
    watchId = navigator.geolocation.watchPosition((p) => {
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      const d = Math.round(distanceM(office, pos));
      showMe();
      if (pos.accuracy > radius) { setGeo('warning', t('att.lowAccuracy', { a: Math.round(pos.accuracy) })); actionBtn.disabled = true; }
      else if (d > radius) { setGeo('danger', t('att.outside', { d, r: radius })); actionBtn.disabled = true; }
      else { setGeo('success', t('att.verified')); actionBtn.disabled = false; }
    }, (e) => {
      setGeo('danger', e.code === 1 ? t('att.denied') : t('err.invalid_coordinates'));
      actionBtn.disabled = true;
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });

    function setGeo(tone, text) {
      geoStatus.className = `att-geo att-geo--${tone}`;
      geoStatus.replaceChildren(icon(tone === 'success' ? 'checkCircle' : tone === 'warning' ? 'alertTriangle' : 'alertCircle'), h('span', {}, text));
    }

    async function submit() {
      if (!pos) return;
      const out = !!a?.checked_in_at;
      setLoading(actionBtn, true, t('common.loading'));
      try {
        const r = await api(out ? 'check_out' : 'check_in', { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy });
        if (out) toast({ title: t('att.doneOut', { h: formatMinutes(r.worked_minutes) }), tone: 'success' });
        else if (r.outcome === 'green') toast({ title: t('att.doneGreen', { window: getLang() === 'ar' ? r.window_label_ar : r.window_label_en }), tone: 'success' });
        else if (r.outcome === 'red') toast({ title: t('att.doneRed', { warn: r.warning_only ? t('att.warnSuffix') : '' }), tone: 'warning' });
        else toast({ title: t('att.doneNone'), tone: 'success' });
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = null; map?.remove(); map = null; youMarker = null;
        await load();
      } catch (err) {
        setLoading(actionBtn, false);
        toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' });
      }
    }
  }

  function windowsCard() {
    const rows = (day.windows || []).map((w) => h('li', { class: 'cluster cluster--between' },
      h('span', {}, getLang() === 'ar' ? w.label_ar : w.label_en),
      h('span', { class: 'num', dir: 'ltr' }, `${hhmm(w.start)} – ${hhmm(w.end)}`)));
    return card({ title: t('att.windows'), subtitle: t('att.expectedEnd', { time: hhmm(day.expected_end_time) }),
      body: rows.length ? h('ul', { class: 'stack stack--sm', role: 'list' }, rows) : h('p', { class: 'text-sm text-muted' }, t('set.noWindows')) });
  }

  function earlyLeaveCard() {
    if (!day.is_work_day || day.attendance?.checked_out_at) return null;
    const el = day.early_leave;
    if (el) {
      const cancel = button({ label: t('el.cancel'), size: 'sm', onClick: async () => {
        if (!(await confirmDialog({ title: t('el.cancel'), text: t('el.cancel'), variant: 'danger' }))) return;
        try { await api('cancel_early_leave', { id: el.id }); toast({ title: t('req.cancelled'), tone: 'success' }); load(); }
        catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      } });
      return card({ title: t('el.title'), body: h('p', {}, t('el.status', { time: hhmm(el.requested_leave_time), status: t(`status.${el.status}`) })), footer: [cancel] });
    }
    const fTime = input({ label: t('el.time'), type: 'time', required: true, attrs: { dir: 'ltr' } });
    const fReason = textarea({ label: t('common.reason'), rows: 2, hint: t('common.optional') });
    const send = button({ label: t('common.submit'), variant: 'secondary', type: 'submit' });
    const form = h('form', { class: 'stack', novalidate: true, onSubmit: async (e) => {
      e.preventDefault();
      const v = fTime.querySelector('input').value;
      if (!v) { setFieldError(fTime, t('err.invalid_time')); return; }
      setFieldError(fTime, null); setLoading(send, true);
      try { await api('request_early_leave', { leave_time: v, reason: fReason.querySelector('textarea').value }); toast({ title: t('el.sent'), tone: 'success' }); load(); }
      catch (err) { setFieldError(fTime, errorMessage(err)); }
      finally { setLoading(send, false); }
    } }, h('div', { class: 'form-grid' }, fTime, fReason), h('div', {}, send));
    return card({ title: t('el.title'), body: form });
  }

  load();
}
