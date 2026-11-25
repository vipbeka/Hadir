// Check-in selfie (only when the owner turns it on). Opens the front camera
// through the system picker (works on iPhone and Android, no permission
// prompt on page load), shrinks the photo to ≤ 720 px JPEG, uploads it to
// the private bucket in the employee's own folder and returns its path.
// Resolves null when the employee closes the dialog.
import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { sb } from '../core/supabase.js';
import { modal } from './modal.js';
import { button, setLoading } from './button.js';
import { alert } from './display.js';

const BUCKET = 'checkin-selfies';
const cairoDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());

/** Image file → JPEG blob, longest side ≤ max px. */
export async function shrink(file, max = 720) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.8));
  } finally { URL.revokeObjectURL(url); }
}

export function takeSelfie(userId) {
  return new Promise((resolve) => {
    let blob = null; let done = false;
    const file = h('input', { type: 'file', accept: 'image/*', capture: 'user', class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' });
    const preview = h('img', { class: 'selfie__preview', alt: t('selfie.previewAlt'), hidden: true });
    const status = h('div', { role: 'status' });
    const take = button({ label: t('selfie.take'), variant: 'secondary', icon: 'user', block: true, onClick: () => file.click() });
    const use = button({ label: t('selfie.use'), variant: 'primary', block: true, disabled: true, onClick: async () => {
      if (!blob) return;
      setLoading(use, true, t('selfie.uploading'));
      const path = `${userId}/${cairoDate()}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.jpg`;
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      setLoading(use, false);
      if (error) { status.replaceChildren(alert(t('selfie.failed'), { tone: 'danger' })); return; }
      done = true; m.close('ok'); resolve(path);
    } });
    file.addEventListener('change', async () => {
      const f = file.files?.[0]; if (!f) return;
      status.replaceChildren();
      try {
        blob = await shrink(f);
        preview.src = URL.createObjectURL(blob); preview.hidden = false;
        use.disabled = false;
        const label = take.querySelector('.btn__label'); if (label) label.textContent = t('selfie.retake');
      } catch { status.replaceChildren(alert(t('selfie.badImage'), { tone: 'danger' })); }
    });
    const m = modal({ title: t('selfie.title'), size: 'sm', body: h('div', { class: 'stack selfie' },
      h('p', { class: 'text-sm text-muted' }, t('selfie.text')), preview, file, take, status),
      actions: [use], onClose: () => { if (!done) resolve(null); } });
    m.open();
  });
}

/** Owner: show an employee's check-in photo (private: downloaded with the owner's session). */
export async function showSelfie(path, title) {
  const body = h('div', { class: 'stack selfie' }, h('p', { class: 'text-sm text-muted' }, t('common.loading')));
  const m = modal({ title, size: 'sm', body, actions: [button({ label: t('common.close'), onClick: () => m.close() })] });
  m.open();
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) { body.replaceChildren(alert(t('selfie.missing'), { tone: 'warning' })); return; }
  const url = URL.createObjectURL(data);
  body.replaceChildren(h('img', { class: 'selfie__preview', src: url, alt: title }));
}
