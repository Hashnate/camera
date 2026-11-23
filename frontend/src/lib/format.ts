/** Display helpers shared across dashboard pages. Times render in the viewer's local time. */

export function fmtTime(iso: string | null | undefined, seconds = false) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
}

/** 45s · 2m 56s · 14m · 6h 05m */
export function fmtDur(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m < 10 && sec ? `${m}m ${sec}s` : `${m}m`;
}

export const fmtMin = (min: number) => fmtDur(min * 60);

/** just now · 4m ago · 2:15 PM (earlier today) · Nov 18, 5:17 PM */
export function timeAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = Math.max(0, (now - t) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  const d = new Date(t);
  if (d.toDateString() === new Date(now).toDateString()) return fmtTime(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Calendar dates (YYYY-MM-DD): do the maths in UTC so they never shift with the viewer's zone. */
export function shiftDate(d: string, days: number) {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function fmtDate(d: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString([], { ...opts, timeZone: 'UTC' });
}

export function initials(name: string | null | undefined) {
  const parts = (name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] || '')).toUpperCase();
}

export function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ---- Office Time "away after not seen for" preference (shared by Overview and Office Time)
// The system-wide value lives in Settings > Attendance; a viewer can override it for their own browser.

export const GAP_OPTIONS = [2, 3, 5, 10, 15];
/** Shown only until the server's setting arrives. */
export const DEFAULT_GAP = 2;
const GAP_KEY = 'worksight_office_time_gap';

/** The gap this viewer picked, or null to use the system setting. */
export function readGap(): number | null {
  try {
    const raw = localStorage.getItem(GAP_KEY);
    const v = Number(raw);
    return raw !== null && GAP_OPTIONS.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember this viewer's choice; null goes back to the system setting. */
export function saveGap(v: number | null) {
  try {
    if (v === null) localStorage.removeItem(GAP_KEY);
    else localStorage.setItem(GAP_KEY, String(v));
  } catch {
    /* per-browser preference only */
  }
}
