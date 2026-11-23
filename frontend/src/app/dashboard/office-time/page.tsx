'use client';

/**
 * Office Time: per-day record of every employee's time inside the office, reconstructed from
 * camera face sightings (about one per minute while someone is visible). Not being seen for
 * longer than the chosen threshold is an away period (stepped outside, or out of camera view).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  Users,
  UserCheck,
  DoorOpen,
  Timer,
  Loader2,
  Info,
  CalendarDays,
  CalendarRange,
  AlertCircle,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { workHoursApi, Sighting, WorkDayRow, WorkPeriodRow } from '@/lib/api';
import { DEFAULT_GAP, GAP_OPTIONS, readGap, saveGap } from '@/lib/format';

const RANGE_OPTIONS = [7, 14, 30];

// ------------------------------------------------------------------ formatting helpers

function fmtTime(iso: string | null, seconds = false) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
}

function fmtDur(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m < 10 && sec ? `${m}m ${sec}s` : `${m}m`;
}

const fmtMin = (min: number) => fmtDur(min * 60);

/** Attendance dates are calendar dates (YYYY-MM-DD); do the maths in UTC so they never shift. */
function shiftDate(d: string, days: number) {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function fmtDate(d: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString([], { ...opts, timeZone: 'UTC' });
}

function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ small pieces

function StatCard({ label, value, sub, icon: Icon, tone }: { label: string; value: React.ReactNode; sub?: string; icon: any; tone: string }) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    indigo: 'bg-indigo-50 text-indigo-600',
  };
  return (
    <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
      <div>
        <p className="text-[11px] font-semibold text-slate-500 uppercase">{label}</p>
        <h4 className="text-xl font-bold text-slate-900 mt-0.5 tabular-nums">{value}</h4>
        {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
      </div>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tones[tone]}`}>
        <Icon className="w-5 h-5" />
      </div>
    </div>
  );
}

function StatusPill({ row, isToday }: { row: WorkDayRow; isToday: boolean }) {
  if (row.state === 'ABSENT') {
    return <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">{isToday ? 'Not in' : 'Absent'}</span>;
  }
  if (row.state === 'IN_OFFICE') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> In office
      </span>
    );
  }
  return isToday ? (
    <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200" title="Not seen by any camera recently: outside, or out of camera view">
      Not seen now
    </span>
  ) : (
    <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">Present</span>
  );
}

/** Day bar: inside stretches green, away periods amber, on a shared time window. */
function TimelineBar({ row, start, end }: { row: WorkDayRow; start: number; end: number }) {
  const span = Math.max(1, end - start);
  const pct = (iso: string) => ((new Date(iso).getTime() - start) / span) * 100;
  if (!row.sessions.length) return <div className="h-2.5 rounded-full bg-slate-100" />;
  return (
    <div className="relative h-2.5 rounded-full bg-slate-100 overflow-hidden">
      {row.awayPeriods.map((p, i) => (
        <div
          key={`a${i}`}
          className="absolute inset-y-0 bg-amber-400"
          style={{ left: `${pct(p.start)}%`, width: `${Math.max(0.6, pct(p.end) - pct(p.start))}%` }}
          title={`Away ${fmtTime(p.start)} – ${fmtTime(p.end)} (${fmtDur(p.seconds)})`}
        />
      ))}
      {row.sessions.map((s, i) => (
        <div
          key={`s${i}`}
          className="absolute inset-y-0 bg-emerald-500"
          style={{ left: `${pct(s.start)}%`, width: `${Math.max(0.6, pct(s.end) - pct(s.start))}%` }}
          title={`Inside ${fmtTime(s.start)} – ${fmtTime(s.end)} (${fmtDur(s.seconds)})`}
        />
      ))}
    </div>
  );
}

function DayDetail({
  row,
  date,
  isToday,
  gap,
}: {
  row: WorkDayRow;
  date: string;
  isToday: boolean;
  gap: number;
}) {
  const [sightings, setSightings] = useState<Sighting[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(() => {
    const out: { kind: 'in' | 'away'; start: string; end: string; seconds: number }[] = [];
    row.sessions.forEach((s, i) => {
      out.push({ kind: 'in', ...s });
      if (row.awayPeriods[i]) out.push({ kind: 'away', ...row.awayPeriods[i] });
    });
    return out;
  }, [row]);

  const loadSightings = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workHoursApi.sightings(row.employee.id, date);
      setSightings(res.data);
    } catch (e: any) {
      setError(e.message || 'Could not load sightings');
    } finally {
      setLoading(false);
    }
  };

  const notSeenFor = isToday && row.state === 'LEFT' && row.lastSeen ? (Date.now() - new Date(row.lastSeen).getTime()) / 1000 : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 p-5 bg-slate-50/70 border-t border-slate-100">
      <div>
        <h5 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">Day breakdown</h5>
        <ol className="relative border-l-2 border-slate-200 ml-1.5 space-y-2.5">
          {items.map((it, i) => (
            <li key={i} className="pl-4 relative">
              <span className={`absolute -left-[7px] top-1 w-3 h-3 rounded-full border-2 border-white ${it.kind === 'in' ? 'bg-emerald-500' : 'bg-amber-400'}`} />
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className={it.kind === 'in' ? 'text-slate-800 font-semibold' : 'text-amber-800 font-semibold'}>
                  {it.kind === 'in' ? 'Inside' : 'Away / not seen'}
                </span>
                <span className="tabular-nums text-slate-500">{fmtDur(it.seconds)}</span>
              </div>
              <p className="text-[11px] text-slate-500 tabular-nums">
                {fmtTime(it.start, true)} → {fmtTime(it.end, true)}
              </p>
            </li>
          ))}
          {isToday && row.state === 'IN_OFFICE' && (
            <li className="pl-4 relative text-xs text-emerald-700 font-semibold">
              <span className="absolute -left-[7px] top-1 w-3 h-3 rounded-full border-2 border-white bg-emerald-500 animate-pulse" />
              Still in the office (seen {fmtTime(row.lastSeen)})
            </li>
          )}
          {notSeenFor > 0 && (
            <li className="pl-4 relative text-xs text-amber-800 font-semibold">
              <span className="absolute -left-[7px] top-1 w-3 h-3 rounded-full border-2 border-white bg-amber-300" />
              Not seen since {fmtTime(row.lastSeen, true)} ({fmtDur(notSeenFor)} so far)
              <p className="text-[11px] font-normal text-slate-500">Counted as away once they are seen again; if not, the day ends at the last sighting.</p>
            </li>
          )}
        </ol>
        <dl className="grid grid-cols-3 gap-2 mt-4 text-xs">
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <dt className="text-[10px] font-semibold text-slate-400 uppercase">Inside</dt>
            <dd className="font-bold text-slate-900 tabular-nums">{fmtDur(row.insideSeconds)}</dd>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <dt className="text-[10px] font-semibold text-slate-400 uppercase">Away</dt>
            <dd className="font-bold text-slate-900 tabular-nums">
              {fmtDur(row.awaySeconds)} <span className="font-normal text-slate-400">· {row.awayPeriods.length}×</span>
            </dd>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-2.5">
            <dt className="text-[10px] font-semibold text-slate-400 uppercase">Scheduled</dt>
            <dd className="font-bold text-slate-900 tabular-nums">{row.scheduledMinutes ? fmtMin(row.scheduledMinutes) : '—'}</dd>
          </div>
        </dl>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h5 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Camera sightings</h5>
          {!sightings && (
            <button
              type="button"
              onClick={loadSightings}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              {loading && <Loader2 className="w-3 h-3 animate-spin" />} Show all {row.sightings}
            </button>
          )}
        </div>
        {error && <p className="text-xs text-rose-600">{error}</p>}
        {!sightings && !error && (
          <p className="text-xs text-slate-500">
            {row.sightings} sightings logged. The camera logs a recognised face at most once a minute; gaps longer than {gap} min are shown as away.
          </p>
        )}
        {sightings && (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  <th className="text-left font-semibold px-3 py-1.5">Time</th>
                  <th className="text-left font-semibold px-3 py-1.5">Camera</th>
                  <th className="text-right font-semibold px-3 py-1.5">Match</th>
                </tr>
              </thead>
              <tbody>
                {sightings.map((s, i) => {
                  const prev = sightings[i - 1];
                  const gapSec = prev ? (new Date(s.seenAt).getTime() - new Date(prev.seenAt).getTime()) / 1000 : 0;
                  return (
                    <React.Fragment key={s.seenAt}>
                      {gapSec > gap * 60 && (
                        <tr className="bg-amber-50 text-amber-800">
                          <td colSpan={3} className="px-3 py-1 font-semibold">
                            Not seen for {fmtDur(gapSec)}
                          </td>
                        </tr>
                      )}
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-1.5 tabular-nums text-slate-700">
                          {fmtTime(s.seenAt, true)}
                          {s.action === 'CHECK_IN' && <span className="ml-1.5 text-[9px] font-bold text-blue-600 uppercase">check-in</span>}
                        </td>
                        <td className="px-3 py-1.5 text-slate-500 truncate max-w-[180px]">
                          {s.cameraName || 'Camera'} · ch {s.channelNo}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{Math.round(s.similarity * 100)}%</td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page

type DailyRes = Awaited<ReturnType<typeof workHoursApi.daily>>;
type SummaryRes = Awaited<ReturnType<typeof workHoursApi.summary>>;

export default function OfficeTimePage() {
  const [view, setView] = useState<'day' | 'history'>('day');
  // null = use the system setting (Settings > Attendance); a number = this viewer picked one here.
  const [chosenGap, setChosenGap] = useState<number | null>(null);
  const [systemGap, setSystemGap] = useState(DEFAULT_GAP);
  const gap = chosenGap ?? systemGap;
  const [today, setToday] = useState<string | null>(null);

  // Day view
  const [date, setDate] = useState<string | null>(null); // null = server's today
  const [daily, setDaily] = useState<DailyRes | null>(null);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // History view
  const [rangeDays, setRangeDays] = useState(7);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);
  const [history, setHistory] = useState<SummaryRes | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => setChosenGap(readGap()), []);

  const changeGap = (v: number | null) => {
    setChosenGap(v);
    saveGap(v);
  };

  const loadDaily = useCallback(
    async (silent = false) => {
      if (!silent) setDailyLoading(true);
      try {
        const res = await workHoursApi.daily(date ?? undefined, chosenGap ?? undefined);
        setDaily(res);
        setSystemGap(res.settings.defaultPresenceGapMin);
        setToday(res.today);
        setDailyError(null);
      } catch (e: any) {
        if (!silent) setDailyError(e.message || 'Could not load office time');
      } finally {
        setDailyLoading(false);
      }
    },
    [date, chosenGap]
  );

  useEffect(() => {
    if (view === 'day') loadDaily();
  }, [view, loadDaily]);

  // Live refresh while looking at today
  useEffect(() => {
    if (view !== 'day' || !daily?.isToday) return;
    const t = setInterval(() => loadDaily(true), 30000);
    return () => clearInterval(t);
  }, [view, daily?.isToday, loadDaily]);

  const loadHistory = useCallback(async () => {
    const end = rangeEnd ?? today;
    if (!end) return;
    setHistoryLoading(true);
    try {
      const res = await workHoursApi.summary(shiftDate(end, -(rangeDays - 1)), end, chosenGap ?? undefined);
      setHistory(res);
      setToday(res.today);
      setHistoryError(null);
    } catch (e: any) {
      setHistoryError(e.message || 'Could not load history');
    } finally {
      setHistoryLoading(false);
    }
  }, [rangeEnd, today, rangeDays, chosenGap]);

  useEffect(() => {
    if (view === 'history') loadHistory();
  }, [view, loadHistory]);

  const shownDate = daily?.date ?? date ?? today;
  const isToday = !!daily?.isToday;

  // Shared time window for the timeline bars
  const windowRange = useMemo(() => {
    const rows = daily?.data.filter((r) => r.sessions.length) ?? [];
    if (!rows.length) return null;
    let start = Math.min(...rows.map((r) => new Date(r.sessions[0].start).getTime()));
    let end = Math.max(...rows.map((r) => new Date(r.sessions[r.sessions.length - 1].end).getTime()));
    if (isToday) end = Math.max(end, Date.now());
    const hour = 3600_000;
    start = Math.floor(start / hour) * hour;
    end = Math.max(start + hour, Math.ceil(end / hour) * hour);
    return { start, end };
  }, [daily, isToday]);

  const exportDay = () => {
    if (!daily) return;
    downloadCsv(`office-time-${daily.date}.csv`, [
      ['Date', 'Employee code', 'Name', 'Department', 'Status', 'Late', 'First seen', 'Last seen', 'Inside (min)', 'Away (min)', 'Times away', 'Away periods', 'Sightings'],
      ...daily.data.map((r) => [
        daily.date,
        r.employee.employeeCode,
        r.employee.fullName,
        r.employee.department,
        r.state === 'ABSENT' ? 'Absent' : r.state === 'IN_OFFICE' ? 'In office' : daily.isToday ? 'Not seen now' : 'Present',
        r.isLate ? 'Yes' : 'No',
        r.firstSeen ? fmtTime(r.firstSeen, true) : '',
        r.lastSeen ? fmtTime(r.lastSeen, true) : '',
        Math.round(r.insideSeconds / 60),
        Math.round(r.awaySeconds / 60),
        r.awayPeriods.length,
        r.awayPeriods.map((p) => `${fmtTime(p.start, true)}-${fmtTime(p.end, true)}`).join('; '),
        r.sightings,
      ]),
    ]);
  };

  const exportHistory = () => {
    if (!history) return;
    downloadCsv(`office-time-${history.startDate}_to_${history.endDate}.csv`, [
      ['Employee code', 'Name', 'Department', ...history.dates.map((d) => `${d} inside (min)`), ...history.dates.map((d) => `${d} away (min)`), 'Days present', 'Late days', 'Total inside (min)', 'Total away (min)', 'Avg inside per present day (min)'],
      ...history.data.map((r) => [
        r.employee.employeeCode,
        r.employee.fullName,
        r.employee.department,
        ...r.days.map((d) => (d.present ? d.insideMinutes : '')),
        ...r.days.map((d) => (d.present ? d.awayMinutes : '')),
        r.daysPresent,
        r.lateDays,
        r.totalInsideMinutes,
        r.totalAwayMinutes,
        r.avgInsideMinutes,
      ]),
    ]);
  };

  const openDay = (d: string) => {
    setDate(d === today ? null : d);
    setExpanded({});
    setView('day');
  };

  const s = daily?.summary;
  const totalAway = daily?.data.reduce((a, r) => a + r.awayPeriods.length, 0) ?? 0;

  return (
    <>
      <Header />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] w-full mx-auto">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="inline-flex p-1 rounded-xl bg-slate-100 border border-slate-200">
            {[
              { key: 'day', label: 'Day', icon: CalendarDays },
              { key: 'history', label: 'History', icon: CalendarRange },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setView(t.key as 'day' | 'history')}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                  view === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <t.icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            ))}
          </div>

          {view === 'day' ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => shownDate && setDate(shiftDate(shownDate, -1))}
                className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600"
                aria-label="Previous day"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="date"
                value={shownDate ?? ''}
                max={today ?? undefined}
                onChange={(e) => e.target.value && setDate(e.target.value === today ? null : e.target.value)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700"
              />
              <button
                type="button"
                onClick={() => shownDate && setDate(shiftDate(shownDate, 1) >= (today ?? '') ? null : shiftDate(shownDate, 1))}
                disabled={isToday}
                className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 disabled:opacity-40"
                aria-label="Next day"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              {!isToday && (
                <button type="button" onClick={() => setDate(null)} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-700 hover:bg-blue-50">
                  Today
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={rangeDays}
                onChange={(e) => setRangeDays(Number(e.target.value))}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700"
              >
                {RANGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    Last {n} days
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">ending</span>
              <input
                type="date"
                value={rangeEnd ?? today ?? ''}
                max={today ?? undefined}
                onChange={(e) => e.target.value && setRangeEnd(e.target.value === today ? null : e.target.value)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700"
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="gap">
              Away after not seen for
            </label>
            <select
              id="gap"
              value={chosenGap === null ? 'system' : String(chosenGap)}
              onChange={(e) => changeGap(e.target.value === 'system' ? null : Number(e.target.value))}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700"
            >
              <option value="system">{systemGap} min (default)</option>
              {GAP_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g} min
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={view === 'day' ? exportDay : exportHistory}
              disabled={view === 'day' ? !daily : !history}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2 text-[11px] text-slate-500 bg-white border border-slate-200 rounded-xl px-4 py-2.5">
          <Info className="w-4 h-4 text-blue-500 shrink-0 mt-px" />
          <p>
            Cameras log each recognised face about once a minute. Not being seen for more than <b>{gap} min</b> counts as away: stepped outside,
            or out of camera view. <b>Inside</b> = first to last sighting minus away periods. Only enrolled employees can be seen.
          </p>
        </div>

        {view === 'day' ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <StatCard label="Employees" value={s?.employees ?? '—'} icon={Users} tone="blue" />
              <StatCard label={isToday ? 'Came in today' : 'Present'} value={s ? `${s.present} / ${s.employees}` : '—'} icon={UserCheck} tone="emerald" />
              <StatCard
                label={isToday ? 'In office now' : 'Times away'}
                value={isToday ? s?.inOfficeNow ?? '—' : totalAway}
                sub={isToday ? `${totalAway} away period${totalAway === 1 ? '' : 's'} today` : undefined}
                icon={DoorOpen}
                tone="amber"
              />
              <StatCard label="Avg inside" value={s ? fmtMin(s.avgInsideMinutes) : '—'} sub={s ? `${fmtMin(s.totalInsideMinutes)} in total` : undefined} icon={Timer} tone="indigo" />
            </div>

            <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">{shownDate ? fmtDate(shownDate) : 'Loading…'}</h3>
                <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
                  {dailyLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                  {isToday ? 'Live · refreshes every 30s' : 'Past day'}
                </span>
              </div>

              {dailyError ? (
                <div className="p-6 text-sm text-rose-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> {dailyError}
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                    <tr>
                      <th className="py-3 px-5">Employee</th>
                      <th className="py-3 px-3">Status</th>
                      <th className="py-3 px-3">First seen</th>
                      <th className="py-3 px-3">Last seen</th>
                      <th className="py-3 px-3 text-right">Inside</th>
                      <th className="py-3 px-3 text-right">Away</th>
                      <th className="py-3 px-3 w-[28%]">
                        Timeline
                        {windowRange && (
                          <span className="normal-case font-normal text-slate-400">
                            {' '}
                            ({fmtTime(new Date(windowRange.start).toISOString())} – {fmtTime(new Date(windowRange.end).toISOString())})
                          </span>
                        )}
                      </th>
                      <th className="py-3 px-3 w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {daily?.data.map((r) => {
                      const open = !!expanded[r.employee.id];
                      const canOpen = r.sessions.length > 0;
                      return (
                        <React.Fragment key={r.employee.id}>
                          <tr
                            onClick={() => canOpen && setExpanded((e) => ({ ...e, [r.employee.id]: !open }))}
                            className={`${canOpen ? 'cursor-pointer hover:bg-slate-50/80' : ''} ${r.state === 'ABSENT' ? 'text-slate-400' : ''}`}
                          >
                            <td className="py-3 px-5">
                              <div className="font-semibold text-slate-900">{r.employee.fullName}</div>
                              <div className="text-[10px] text-slate-400 font-mono">
                                {r.employee.employeeCode}
                                {r.employee.department ? ` · ${r.employee.department}` : ''}
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-1.5">
                                <StatusPill row={r} isToday={isToday} />
                                {r.isLate && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-50 text-rose-600 border border-rose-200">LATE</span>}
                              </div>
                            </td>
                            <td className="py-3 px-3 tabular-nums">{fmtTime(r.firstSeen ?? r.checkIn)}</td>
                            <td className="py-3 px-3 tabular-nums">{fmtTime(r.lastSeen)}</td>
                            <td className="py-3 px-3 text-right tabular-nums font-bold text-slate-900">{r.date ? fmtDur(r.insideSeconds) : '—'}</td>
                            <td className="py-3 px-3 text-right tabular-nums">
                              {r.awayPeriods.length ? (
                                <span className="text-amber-700 font-semibold">
                                  {fmtDur(r.awaySeconds)} <span className="font-normal text-slate-400">· {r.awayPeriods.length}×</span>
                                </span>
                              ) : r.date ? (
                                <span className="text-slate-400">0</span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="py-3 px-3">{windowRange ? <TimelineBar row={r} start={windowRange.start} end={windowRange.end} /> : null}</td>
                            <td className="py-3 px-3 text-slate-400">
                              {canOpen && <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />}
                            </td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={8} className="p-0">
                                <DayDetail row={r} date={daily.date} isToday={isToday} gap={gap} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {daily && !daily.data.length && (
                      <tr>
                        <td colSpan={8} className="py-10 text-center text-slate-400">
                          No active employees.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
              <div className="px-5 py-2.5 border-t border-slate-100 flex items-center gap-4 text-[10px] text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-2 rounded-sm bg-emerald-500" /> Inside (seen by a camera)
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-2 rounded-sm bg-amber-400" /> Away / not seen
                </span>
                <span>Click a row for the full breakdown and every camera sighting.</span>
              </div>
            </div>
          </>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                {history ? `${fmtDate(history.startDate, { day: 'numeric', month: 'short' })} – ${fmtDate(history.endDate)}` : 'Loading…'}
              </h3>
              <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
                {historyLoading && <Loader2 className="w-3 h-3 animate-spin" />} Inside time per day · click a day for details
              </span>
            </div>
            {historyError ? (
              <div className="p-6 text-sm text-rose-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" /> {historyError}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[10px] uppercase tracking-wider">
                    <tr>
                      <th className="py-3 px-5 text-left font-semibold sticky left-0 bg-slate-50 min-w-[180px]">Employee</th>
                      {history?.dates.map((d) => {
                        const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                        return (
                          <th key={d} className={`py-3 px-2 text-center font-semibold min-w-[72px] ${wd === 0 || wd === 6 ? 'text-slate-400' : ''}`}>
                            <div>{fmtDate(d, { weekday: 'short' })}</div>
                            <div className="text-slate-700 normal-case text-xs">{fmtDate(d, { day: 'numeric', month: 'short' })}</div>
                          </th>
                        );
                      })}
                      <th className="py-3 px-3 text-right font-semibold">Days</th>
                      <th className="py-3 px-3 text-right font-semibold">Total inside</th>
                      <th className="py-3 px-3 text-right font-semibold">Avg / day</th>
                      <th className="py-3 px-3 text-right font-semibold">Total away</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {history?.data.map((r: WorkPeriodRow) => (
                      <tr key={r.employee.id}>
                        <td className="py-2.5 px-5 sticky left-0 bg-white">
                          <div className="font-semibold text-slate-900">{r.employee.fullName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{r.employee.employeeCode}</div>
                        </td>
                        {r.days.map((d) => (
                          <td key={d.date} className="py-1.5 px-1 text-center">
                            {d.present ? (
                              <button
                                type="button"
                                onClick={() => openDay(d.date)}
                                className="w-full rounded-lg px-1.5 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 transition"
                                title={`${fmtTime(d.firstSeen)} – ${fmtTime(d.lastSeen)} · away ${fmtMin(d.awayMinutes)} (${d.timesAway}×)${d.isLate ? ' · late' : ''}`}
                              >
                                <div className="font-bold text-emerald-900 tabular-nums">{fmtMin(d.insideMinutes)}</div>
                                <div className="text-[10px] tabular-nums text-slate-500">
                                  {d.timesAway ? <span className="text-amber-700">away {fmtMin(d.awayMinutes)}</span> : 'no away'}
                                  {d.isLate && <span className="text-rose-600 font-bold"> · L</span>}
                                </div>
                              </button>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        ))}
                        <td className="py-2.5 px-3 text-right tabular-nums">{r.daysPresent}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums font-bold text-slate-900">{fmtMin(r.totalInsideMinutes)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums">{fmtMin(r.avgInsideMinutes)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-amber-700">{fmtMin(r.totalAwayMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-5 py-2.5 border-t border-slate-100 text-[10px] text-slate-500">
              Every active employee has a row for every day: — means not seen that day. L = late arrival.
            </div>
          </div>
        )}
      </main>
    </>
  );
}
