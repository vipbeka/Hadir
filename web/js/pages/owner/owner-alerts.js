// Owner settings → «إشعارات المالك الفورية»: per-type toggles for the three
// channels (Telegram, in-app list, device push), whether Telegram is really
// connected (with the connection steps when it isn't), a test notification,
// this device's push subscription (enable / turn off) with iPhone/Android
// guidance, the alert sound, and the delivery log (attempts and errors).
import { h, add, fill } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { api } from '../../core/api.js';
import { errorMessage } from '../../core/errors.js';
import { formatDateTime } from '../../core/format.js';
import { card, alert, badge, skeletonCard } from '../../ui/display.js';
import { button, setLoading } from '../../ui/button.js';
import { switchControl } from '../../ui/field.js';
import { toast } from '../../ui/toast.js';
import { pushStatus, enablePush, disablePush, iosNeedsInstall } from '../../core/push.js';
import { soundOn, setSound, chime } from '../../core/owner-live.js';

const TYPES = ['check_in', 'check_out', 'absence', 'request'];
const CHANNELS = ['telegram', 'app', 'push'];

export async function renderOwnerAlerts(slot, { me } = {}) {
  fill(slot, skeletonCard(t('common.loading')));
  let st; let tg = null;
  try {
    [st, tg] = await Promise.all([api('notify_status'), api('telegram_status').catch(() => null)]);
  } catch (err) { fill(slot, card({ title: t('oa.title'), body: alert(errorMessage(err), { tone: 'danger' }) })); return; }

  // ---- Telegram status (never silent)
  const tgReady = st.telegram_channel_on && st.telegram_chat_set && tg && !tg.token_missing && tg.connected !== false;
  const tgLine = h('div', { class: 'notify-status' },
    h('p', { class: 'cluster' }, h('span', {}, t('oa.tg')), tgReady ? badge(t('oa.connected'), { tone: 'success', dot: true }) : badge(t('oa.notConnected'), { tone: 'warning', dot: true })),
    tgReady ? null : alert(h('span', {}, t(!st.telegram_channel_on ? 'oa.tgOff' : !st.telegram_chat_set ? 'oa.tgNoChat' : tg?.token_missing ? 'oa.tgNoToken' : 'oa.tgNoHook'),
      h('ol', { class: 'text-sm' }, h('li', {}, t('oa.step1')), h('li', {}, t('oa.step2')), h('li', {}, t('oa.step3')), h('li', {}, t('oa.step4')))), { tone: 'warning' }),
    st.last_telegram ? h('p', { class: 'text-sm text-muted' }, t('oa.lastTg', { at: formatDateTime(st.last_telegram.at), s: t(`oa.st.${st.last_telegram.status}`) }),
      st.last_telegram.error ? h('span', { dir: 'ltr' }, ` — ${st.last_telegram.error}`) : null) : null);

  // ---- toggles grid (type × channel)
  const prefs = st.prefs || {};
  const sw = {};
  const grid = h('div', { class: 'alert-grid', role: 'group', 'aria-label': t('oa.toggles') },
    h('span', {}), ...CHANNELS.map((c) => h('span', { class: 'alert-grid__head' }, t(`oa.ch.${c}`))),
    ...TYPES.flatMap((ty) => [h('span', { class: 'alert-grid__type' }, t(`oa.t.${ty}`)),
      ...CHANNELS.map((c) => { sw[`${ty}.${c}`] = switchControl({ label: `${t(`oa.t.${ty}`)} — ${t(`oa.ch.${c}`)}`, checked: prefs[ty]?.[c] !== false }); return sw[`${ty}.${c}`]; })]));
  const saveStatus = h('p', { class: 'save-status text-sm', role: 'status' });
  const saveBtn = button({ label: t('common.save'), variant: 'primary', size: 'sm', onClick: async () => {
    setLoading(saveBtn, true);
    const out = {};
    TYPES.forEach((ty) => { out[ty] = {}; CHANNELS.forEach((c) => { out[ty][c] = sw[`${ty}.${c}`].querySelector('input').checked; }); });
    try { await api('owner_alert_prefs', { prefs: out }); saveStatus.textContent = t('set.saved'); toast({ title: t('set.saved'), tone: 'success' }); }
    catch (err) { saveStatus.textContent = errorMessage(err); toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    finally { setLoading(saveBtn, false); }
  } });

  // ---- test
  const testBtn = button({ label: t('oa.test'), size: 'sm', icon: 'bell', onClick: async () => {
    setLoading(testBtn, true);
    try {
      const r = await api('notify_test');
      toast({ title: t('oa.testSent'), text: [t('oa.testApp'), r.push_queued ? t('oa.testPush', { n: r.push_queued }) : t('oa.testNoPush'),
        r.telegram_queued ? t('oa.testTg') : t('oa.testNoTg')].join(' · '), tone: r.telegram_queued ? 'success' : 'warning', duration: 9000 });
    } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
    finally { setLoading(testBtn, false); }
  } });

  // ---- this device (Web Push)
  const devBox = h('div', { class: 'notify-status' });
  const renderDevice = async () => {
    const s = await pushStatus(me?.id);
    const guide = h('ul', { class: 'text-sm text-muted' }, h('li', {}, t('oa.guideIos')), h('li', {}, t('oa.guideAndroid')));
    const devices = h('p', { class: 'text-sm text-muted' }, t('oa.devices', { n: st.push_devices }));
    if (s === 'enabled') {
      const off = button({ label: t('oa.deviceOff'), size: 'sm', variant: 'ghost', onClick: async () => {
        setLoading(off, true);
        try { await disablePush(); st.push_devices = Math.max(0, st.push_devices - 1); toast({ title: t('oa.deviceOffDone'), tone: 'info' }); }
        catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
        finally { renderDevice(); }
      } });
      fill(devBox, h('p', { class: 'cluster' }, badge(t('oa.deviceOn'), { tone: 'success', dot: true }), off), devices, guide);
      return;
    }
    if (s === 'unsupported' || iosNeedsInstall()) { fill(devBox, alert(t('oa.deviceIos'), { tone: 'info' }), devices, guide); return; }
    if (s === 'denied') { fill(devBox, alert(t('push.denied'), { tone: 'warning' }), devices, guide); return; }
    const on = button({ label: t('oa.deviceEnable'), variant: 'primary', size: 'sm', icon: 'bell', onClick: async () => {
      setLoading(on, true);
      try {
        const r = await enablePush(me?.id);
        if (r === 'enabled') { st.push_devices += 1; toast({ title: t('oa.deviceOn'), tone: 'success' }); }
        else toast({ title: t('push.denied'), tone: 'warning' });
      } catch (err) { toast({ title: t('error.title'), text: errorMessage(err), tone: 'danger' }); }
      finally { renderDevice(); }
    } });
    fill(devBox, h('p', { class: 'cluster' }, badge(t('oa.deviceNot'), { tone: 'neutral', dot: true }), on), devices, guide);
  };
  renderDevice();

  // ---- sound (this device)
  const sound = switchControl({ label: t('oa.sound'), checked: soundOn(), onChange: (e) => { setSound(e.target.checked); if (e.target.checked) chime(); } });

  // ---- delivery log
  const logBox = h('div', { class: 'notify-log' });
  const logDetails = h('details', { onToggle: async (e) => {
    if (!e.target.open || logBox.dataset.loaded) return;
    logBox.dataset.loaded = '1'; fill(logBox, h('p', { class: 'text-muted' }, t('common.loading')));
    try {
      const r = await api('notify_log', { limit: 40 });
      const rows = [...(r.errors || []).map((x) => h('li', {}, badge(t('oa.st.dead'), { tone: 'danger' }), ' ', formatDateTime(x.at), ' — ', x.event, ' ', h('span', { dir: 'ltr' }, x.error))),
        ...(r.deliveries || []).map((x) => h('li', {}, badge(t(`oa.st.${x.status}`), { tone: x.status === 'sent' ? 'success' : x.status === 'dead' ? 'danger' : 'neutral' }), ' ',
          formatDateTime(x.created_at), ' — ', t(`oa.ch.${x.channel === 'web_push' ? 'push' : 'telegram'}`), ' · ', x.employee || '—', ' · ', x.event_type,
          x.attempt_count > 1 ? ` (${t('oa.attempts', { n: x.attempt_count })})` : '', x.last_error ? h('span', { dir: 'ltr' }, ` — ${x.last_error}`) : null))];
      fill(logBox, rows.length ? h('ul', { class: 'stack' }, rows) : h('p', { class: 'text-muted' }, t('oa.logEmpty')));
    } catch (err) { fill(logBox, alert(errorMessage(err), { tone: 'danger' })); delete logBox.dataset.loaded; }
  } }, h('summary', {}, t('oa.log')), logBox);

  fill(slot, card({ title: t('oa.title'), subtitle: t('oa.subtitle'), iconName: 'bell', body: h('div', { class: 'stack' },
    tgLine,
    h('h4', { class: 'text-sm' }, t('oa.toggles')), grid,
    h('div', { class: 'cluster' }, saveBtn, testBtn, saveStatus),
    h('h4', { class: 'text-sm' }, t('oa.device')), devBox,
    sound, logDetails) }));
}
