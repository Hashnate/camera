'use client';

/**
 * Office Time: each employee's day inside the office, reconstructed from camera sightings.
 * Face sightings (about every 30 s while visible) plus time a recognised person is followed by body
 * tracking count as inside; going unseen for longer than the "away after" threshold is an away period.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Eye,
  EyeOff,
  HelpCircle,
  Loader2,
  LogIn,
  RefreshCw,
  Search,
  Timer,
  UserCheck,
  Users,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Avatar, btn, Card, EmptyState, Skeleton, StatTile } from '@/components/ui';
import { AwayCell, ArrivalCell, InsideCell, StatusCell, TimeAxis, TimelineBar, ms, pctOfSchedule, presenceOf, timeWindow } from '@/components/officeTime';
import { workHoursApi, WorkDayRow, WorkPeriodRow } from '@/lib/api';
import { DEFAULT_GAP, GAP_OPTIONS, fmtDate, fmtDur, fmtMin, fmtTime, readGap, saveGap, shiftDate, timeAgo } from '@/lib/format';

const RANGE_OPTIONS = [7, 14, 30];

type DailyRes = Awaited<ReturnType<typeof workHoursApi.daily>>;
type SummaryRes = Awaited<ReturnType<typeof workHoursApi.summary>>;
type Filter = 'all' | 'in' | 'away' | 'out' | 'late';
type SortKey = 'status' | 'name' | 'arrival' | 'inside' | 'away';

// ------------------------------------------------------------------ helpers

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

function matchesFilter(r: WorkDayRow, f: Filter) {
  if (f === 'all') return true;
  if (f === 'in') return r.state === 'IN_OFFICE';
  if (f === 'away') return r.state === 'LEFT';
  if (f === 'out') return r.state === 'ABSENT';
  return r.isLate;
}

// ------------------------------------------------------------------ page

export default function OfficeTimePageRoute() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <React.Suspense fallback={<Header />}>
      <OfficeTimePage />
    </React.Suspense>
  );
}

function OfficeTimePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<'day' | 'history'>('day');
  // null = use the system setting (Settings > Attendance); a number = this viewer picked one here.
  const [chosenGap, setChosenGap] = useState<number | null>(null);
  const [systemGap, setSystemGap] = useState(DEFAULT_GAP);
  const gap = chosenGap ?? systemGap;
  const [today, setToday] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showHelp, setShowHelp] = useState(false);

  // Day view
  // null = server's today. Kept in the URL (?date=) so Back from an employee page returns to the same day.
  const [date, setDateState] = useState<string | null>(() => searchParams.get('date'));
  const setDate = (d: string | null) => {
    setDateState(d);
    router.replace(d ? `/dashboard/office-time?date=${d}` : '/dashboard/office-time', { scroll: false });
  };
  const [daily, setDaily] = useState<DailyRes | null>(null);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('status');

  // History view
  const [rangeDays, setRangeDays] = useState(7);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);
  const [history, setHistory] = useState<SummaryRes | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => setChosenGap(readGap()), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

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
        setUpdatedAt(Date.now());
        setNow(Date.now());
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
  const rows = daily?.data ?? [];

  const windowRange = useMemo(() => timeWindow(rows, isToday, now), [rows, isToday, now]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      in: rows.filter((r) => r.state === 'IN_OFFICE').length,
      away: rows.filter((r) => r.state === 'LEFT').length,
      out: rows.filter((r) => r.state === 'ABSENT').length,
      late: rows.filter((r) => r.isLate).length,
    }),
    [rows]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        matchesFilter(r, filter) &&
        (!q || [r.employee.fullName, r.employee.employeeCode, r.employee.department ?? ''].some((v) => v.toLowerCase().includes(q)))
    );
    const arrival = (r: WorkDayRow) => (r.firstSeen ?? r.checkIn ? ms((r.firstSeen ?? r.checkIn)!) : Infinity);
    const byName = (a: WorkDayRow, b: WorkDayRow) => a.employee.fullName.localeCompare(b.employee.fullName);
    const cmp: Record<SortKey, (a: WorkDayRow, b: WorkDayRow) => number> = {
      status: (a, b) => presenceOf(a, isToday).order - presenceOf(b, isToday).order || arrival(a) - arrival(b) || byName(a, b),
      name: byName,
      arrival: (a, b) => arrival(a) - arrival(b) || byName(a, b),
      inside: (a, b) => b.insideSeconds - a.insideSeconds || byName(a, b),
      away: (a, b) => b.awaySeconds - a.awaySeconds || byName(a, b),
    };
    return [...list].sort(cmp[sort]);
  }, [rows, filter, query, sort, isToday]);

  const exportDay = () => {
    if (!daily) return;
    downloadCsv(`office-time-${daily.date}.csv`, [
      ['Date', 'Employee code', 'Name', 'Department', 'Status', 'Late', 'Late by (min)', 'Arrived', 'Last seen', 'Inside (min)', '% of schedule', 'Away (min)', 'Times away', 'Longest away (min)', 'Away periods', 'Face sightings'],
      ...daily.data.map((r) => [
        daily.date,
        r.employee.employeeCode,
        r.employee.fullName,
        r.employee.department,
        presenceOf(r, daily.isToday).label,
        r.isLate ? 'Yes' : 'No',
        r.lateByMinutes || '',
        r.firstSeen ? fmtTime(r.firstSeen, true) : '',
        r.lastSeen ? fmtTime(r.lastSeen, true) : '',
        Math.round(r.insideSeconds / 60),
        pctOfSchedule(r) ?? '',
        Math.round(r.awaySeconds / 60),
        r.awayPeriods.length,
        Math.round(r.longestAwaySeconds / 60),
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
    setView('day');
  };

  // The employee page opens on the day being viewed (no date = today).
  const employeeHref = (id: string) => `/dashboard/office-time/${id}${date ? `?date=${date}` : ''}`;

  // ---- summary tiles
  const s = daily?.summary;
  const present = rows.filter((r) => r.date);
  const totalAwaySec = present.reduce((a, r) => a + r.awaySeconds, 0);
  const sched = present.find((r) => r.scheduledMinutes)?.scheduledMinutes ?? null;
  const avgPct = s && sched ? Math.round((s.avgInsideMinutes / sched) * 100) : null;
  const inNow = rows.filter((r) => r.state === 'IN_OFFICE');
  const notSeen = rows.filter((r) => r.state === 'LEFT' && r.lastSeen).sort((a, b) => ms(a.lastSeen!) - ms(b.lastSeen!));

  const FILTERS: { key: Filter; label: string; show: boolean }[] = [
    { key: 'all', label: 'Everyone', show: true },
    { key: 'in', label: 'In office', show: isToday },
    { key: 'away', label: isToday ? 'Not seen now' : 'Was in', show: true },
    { key: 'out', label: isToday ? 'Not in yet' : 'Absent', show: true },
    { key: 'late', label: 'Late', show: true },
  ];

  const selectCls = 'h-9 pl-2.5 pr-7 rounded-lg bg-white ring-1 ring-inset ring-slate-200 text-[13px] text-slate-700 shadow-sm border-0 focus:ring-2 focus:ring-blue-500';

  return (
    <>
      <Header />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-5 max-w-[1440px] w-full mx-auto">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex p-1 rounded-xl bg-slate-100 ring-1 ring-inset ring-slate-200/70" role="tablist" aria-label="View">
              {[
                { key: 'day', label: 'Day', icon: CalendarDays },
                { key: 'history', label: 'History', icon: CalendarRange },
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={view === t.key}
                  onClick={() => setView(t.key as 'day' | 'history')}
                  className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[13px] font-medium transition ${
                    view === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <t.icon className="w-3.5 h-3.5" /> {t.label}
                </button>
              ))}
            </div>

            {view === 'day' ? (
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => shownDate && setDate(shiftDate(shownDate, -1))} className={`${btn.secondary} !px-2.5`} aria-label="Previous day">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <label className="relative">
                  <span className="sr-only">Date</span>
                  <input
                    type="date"
                    value={shownDate ?? ''}
                    max={today ?? undefined}
                    onChange={(e) => e.target.value && setDate(e.target.value === today ? null : e.target.value)}
                    className="h-9 px-3 rounded-lg bg-white ring-1 ring-inset ring-slate-200 text-[13px] font-medium text-slate-700 shadow-sm border-0"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => shownDate && setDate(shiftDate(shownDate, 1) >= (today ?? '') ? null : shiftDate(shownDate, 1))}
                  disabled={isToday}
                  className={`${btn.secondary} !px-2.5`}
                  aria-label="Next day"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                {!isToday && daily && (
                  <button type="button" onClick={() => setDate(null)} className={btn.secondary}>
                    Today
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))} className={selectCls} aria-label="Range">
                  {RANGE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      Last {n} days
                    </option>
                  ))}
                </select>
                <span className="text-[13px] text-slate-500">ending</span>
                <input
                  type="date"
                  value={rangeEnd ?? today ?? ''}
                  max={today ?? undefined}
                  onChange={(e) => e.target.value && setRangeEnd(e.target.value === today ? null : e.target.value)}
                  className="h-9 px-3 rounded-lg bg-white ring-1 ring-inset ring-slate-200 text-[13px] font-medium text-slate-700 shadow-sm border-0"
                  aria-label="End date"
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {view === 'day' && isToday && (
              <button
                type="button"
                onClick={() => loadDaily()}
                className="inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-[12.5px] text-slate-500 hover:text-slate-800 hover:bg-white"
                title="Refreshes every 30 seconds"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${dailyLoading ? 'animate-spin' : ''}`} />
                {updatedAt ? `Updated ${timeAgo(new Date(updatedAt).toISOString(), now)}` : 'Live'}
              </button>
            )}
            <label className="flex items-center gap-2 text-[12.5px] text-slate-500" title="How long someone must go unseen before it counts as away (only for your browser)">
              Away after
              <select
                value={chosenGap === null ? 'system' : String(chosenGap)}
                onChange={(e) => changeGap(e.target.value === 'system' ? null : Number(e.target.value))}
                className={selectCls}
              >
                <option value="system">{systemGap} min (default)</option>
                {GAP_OPTIONS.filter((g) => g !== systemGap).map((g) => (
                  <option key={g} value={g}>
                    {g} min
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => setShowHelp((v) => !v)} className={`${btn.secondary} !px-2.5`} aria-expanded={showHelp} aria-label="How is this measured?">
              <HelpCircle className="w-4 h-4" />
            </button>
            <button type="button" onClick={view === 'day' ? exportDay : exportHistory} disabled={view === 'day' ? !daily : !history} className={btn.secondary}>
              <Download className="w-4 h-4" /> Export CSV
            </button>
          </div>
        </div>

        {showHelp && (
          <Card className="px-5 py-4 text-[12.5px] text-slate-600 leading-relaxed">
            <p className="font-medium text-slate-900 mb-1">How office time is measured</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>
                <b className="font-medium text-slate-800">Inside</b>: the camera recognises a face (about every 30 seconds while visible), and body tracking keeps
                following a recognised person when they turn away or move seats.
              </li>
              <li>
                <b className="font-medium text-slate-800">Away</b>: not seen by any lens for more than {gap} min (stepped out, or out of every camera&apos;s view).
              </li>
              <li>
                <b className="font-medium text-slate-800">Late</b>: first seen after the work-schedule start plus its grace period. Only enrolled employees can be
                recognised.
              </li>
            </ul>
          </Card>
        )}

        {view === 'day' ? (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {isToday ? (
                <>
                  <StatTile
                    label="In office now"
                    icon={Eye}
                    value={s ? <span className="tabular-nums">{inNow.length}</span> : <Skeleton className="h-7 w-10" />}
                    sub={
                      inNow.length ? (
                        <span className="flex items-center gap-2">
                          <span className="flex -space-x-1.5">
                            {inNow.slice(0, 5).map((r) => (
                              <span key={r.employee.id} className="ring-2 ring-white rounded-full" title={r.employee.fullName}>
                                <Avatar name={r.employee.fullName} id={r.employee.id} size="sm" />
                              </span>
                            ))}
                          </span>
                          {inNow.length > 5 && <span>+{inNow.length - 5}</span>}
                        </span>
                      ) : s ? (
                        'Nobody in view right now'
                      ) : undefined
                    }
                  />
                  <StatTile
                    label="Not seen now"
                    icon={EyeOff}
                    value={s ? <span className={`tabular-nums ${notSeen.length ? 'text-amber-700' : ''}`}>{notSeen.length}</span> : <Skeleton className="h-7 w-10" />}
                    sub={
                      notSeen.length
                        ? `${notSeen[0].employee.fullName.split(' ')[0]} for ${fmtDur((now - ms(notSeen[0].lastSeen!)) / 1000)}${notSeen.length > 1 ? ` · +${notSeen.length - 1} more` : ''}`
                        : s
                        ? 'Everyone who came in is in view'
                        : undefined
                    }
                  />
                </>
              ) : (
                <>
                  <StatTile label="Present" icon={UserCheck} value={s ? <span className="tabular-nums">{s.present} / {s.employees}</span> : <Skeleton className="h-7 w-16" />} sub={s ? `${s.employees - s.present} absent` : undefined} />
                  <StatTile
                    label="Time away"
                    icon={EyeOff}
                    value={s ? <span className="tabular-nums">{fmtDur(totalAwaySec)}</span> : <Skeleton className="h-7 w-16" />}
                    sub={s ? `${present.reduce((a, r) => a + r.awayPeriods.length, 0)} away periods` : undefined}
                  />
                </>
              )}
              <StatTile
                label={isToday ? 'Arrived today' : 'Arrivals'}
                icon={LogIn}
                value={s ? <span className="tabular-nums">{s.present} <span className="text-slate-400 text-[20px]">/ {s.employees}</span></span> : <Skeleton className="h-7 w-16" />}
                sub={
                  s ? (
                    <span>
                      {counts.late ? <span className="text-rose-700 font-medium">{counts.late} late</span> : <span className="text-emerald-700">All on time</span>}
                      {isToday && counts.out ? ` · ${counts.out} not in yet` : ''}
                    </span>
                  ) : undefined
                }
              />
              <StatTile
                label="Average time inside"
                icon={Timer}
                value={s ? <span className="tabular-nums">{fmtMin(s.avgInsideMinutes)}</span> : <Skeleton className="h-7 w-20" />}
                sub={s ? (avgPct !== null ? `${avgPct}% of the ${fmtMin(sched!)} work day` : `${fmtMin(s.totalInsideMinutes)} in total`) : undefined}
              />
            </div>

            {/* People */}
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3">
                <div>
                  <h2 className="text-[14px] font-semibold text-slate-900">{shownDate ? fmtDate(shownDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'Loading…'}</h2>
                  <p className="text-[12.5px] text-slate-500 mt-0.5">{isToday ? 'Live · tap a person to open their day' : 'Past day · tap a person to open their day'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                  <label className="relative flex-1 min-w-0 sm:flex-none">
                    <span className="sr-only">Search employees</span>
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search name, code, team"
                      className="h-9 w-full sm:w-52 pl-8 pr-3 rounded-lg bg-white ring-1 ring-inset ring-slate-200 text-[13px] text-slate-700 placeholder:text-slate-400 border-0 focus:ring-2 focus:ring-blue-500"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-[12.5px] text-slate-500">
                    Sort
                    <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={selectCls}>
                      <option value="status">Status</option>
                      <option value="arrival">Arrival time</option>
                      <option value="inside">Most time inside</option>
                      <option value="away">Most time away</option>
                      <option value="name">Name</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 px-4 sm:px-5 pb-3" role="group" aria-label="Filter">
                {FILTERS.filter((f) => f.show).map((f) => {
                  const active = filter === f.key;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setFilter(f.key)}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12.5px] font-medium ring-1 ring-inset transition ${
                        active ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {f.label}
                      <span className={`tabular-nums text-[11.5px] ${active ? 'text-slate-300' : 'text-slate-400'}`}>{counts[f.key]}</span>
                    </button>
                  );
                })}
              </div>

              {dailyError ? (
                <div className="px-5 py-6 text-[13px] text-rose-700 flex items-center gap-2 border-t border-slate-100">
                  <AlertCircle className="w-4 h-4" /> {dailyError}
                  <button type="button" onClick={() => loadDaily()} className={`${btn.secondary} ml-2`}>
                    Try again
                  </button>
                </div>
              ) : (
                <div className="border-t border-slate-100">
                  {/* Phones: one card per person (the table needs about 760px) */}
                  <ul className="md:hidden divide-y divide-slate-100">
                    {!daily &&
                      dailyLoading &&
                      [0, 1, 2].map((i) => (
                        <li key={i} className="px-4 py-3.5">
                          <Skeleton className="h-24" />
                        </li>
                      ))}
                    {visible.map((r) => (
                      <li key={r.employee.id}>
                        <Link href={employeeHref(r.employee.id)} className="block px-4 py-3.5 active:bg-slate-50 transition-colors">
                          <div className="flex items-center gap-3">
                            <Avatar name={r.employee.fullName} id={r.employee.id} />
                            <div className="min-w-0 flex-1">
                              <p className={`text-[14px] font-medium truncate ${r.state === 'ABSENT' ? 'text-slate-500' : 'text-slate-900'}`}>{r.employee.fullName}</p>
                              <p className="text-[12px] text-slate-500 truncate">
                                {r.employee.employeeCode}
                                {r.employee.department ? ` · ${r.employee.department}` : ''}
                              </p>
                            </div>
                            <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" aria-hidden="true" />
                          </div>
                          <div className="mt-2 pl-12">
                            <StatusCell row={r} isToday={isToday} now={now} />
                          </div>
                          {r.date && (
                            <dl className="mt-3 grid grid-cols-3 gap-2 pt-3 border-t border-slate-100">
                              <div className="min-w-0">
                                <dt className="text-[11px] text-slate-500 mb-0.5">Arrived</dt>
                                <dd>
                                  <ArrivalCell row={r} />
                                </dd>
                              </div>
                              <div className="min-w-0">
                                <dt className="text-[11px] text-slate-500 mb-0.5">Inside</dt>
                                <dd>
                                  <InsideCell row={r} />
                                </dd>
                              </div>
                              <div className="min-w-0">
                                <dt className="text-[11px] text-slate-500 mb-0.5">Away</dt>
                                <dd>
                                  <AwayCell row={r} />
                                </dd>
                              </div>
                            </dl>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left min-w-[760px]">
                    <thead className="bg-slate-50/70 text-slate-500 text-[11.5px] font-medium">
                      <tr>
                        <th className="py-2.5 pl-5 pr-3 font-medium">Employee</th>
                        <th className="py-2.5 px-3 font-medium">Status</th>
                        <th className="py-2.5 px-3 font-medium">Arrived</th>
                        <th className="py-2.5 px-3 font-medium">Inside</th>
                        <th className="py-2.5 px-3 font-medium">Away</th>
                        <th className="py-2.5 px-3 font-medium w-[30%] hidden lg:table-cell">
                          {windowRange ? <TimeAxis start={windowRange.start} end={windowRange.end} /> : 'Timeline'}
                        </th>
                        <th className="py-2.5 pr-4 w-8">
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {!daily &&
                        dailyLoading &&
                        [0, 1, 2].map((i) => (
                          <tr key={i}>
                            <td colSpan={7} className="px-5 py-4">
                              <Skeleton className="h-9" />
                            </td>
                          </tr>
                        ))}
                      {visible.map((r) => {
                        const href = employeeHref(r.employee.id);
                        return (
                            <tr
                              key={r.employee.id}
                              onClick={(e) => {
                                if (window.getSelection()?.toString()) return; // let people select text
                                if (e.metaKey || e.ctrlKey) window.open(href, '_blank');
                                else router.push(href);
                              }}
                              className="group align-top cursor-pointer transition-colors hover:bg-slate-50/80"
                            >
                              <td className="py-3.5 pl-5 pr-3">
                                <div className="flex items-center gap-3">
                                  <Avatar name={r.employee.fullName} id={r.employee.id} />
                                  <div className="min-w-0">
                                    <Link
                                      href={href}
                                      onClick={(e) => e.stopPropagation()}
                                      className={`block text-[13.5px] font-medium truncate group-hover:text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded ${
                                        r.state === 'ABSENT' ? 'text-slate-500' : 'text-slate-900'
                                      }`}
                                    >
                                      {r.employee.fullName}
                                    </Link>
                                    <p className="text-[11.5px] text-slate-500 truncate">
                                      {r.employee.employeeCode}
                                      {r.employee.department ? ` · ${r.employee.department}` : ''}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="py-3.5 px-3">
                                <StatusCell row={r} isToday={isToday} now={now} />
                              </td>
                              <td className="py-3.5 px-3">
                                <ArrivalCell row={r} />
                              </td>
                              <td className="py-3.5 px-3">
                                <InsideCell row={r} />
                              </td>
                              <td className="py-3.5 px-3">
                                <AwayCell row={r} />
                              </td>
                              <td className="py-3.5 px-3 hidden lg:table-cell">
                                <div className="pt-1.5">
                                  {windowRange && r.date ? (
                                    <TimelineBar row={r} start={windowRange.start} end={windowRange.end} now={now} isToday={isToday} />
                                  ) : (
                                    <p className="text-[12px] text-slate-400 pt-0.5">{isToday ? 'Not seen by a camera today' : 'Not seen this day'}</p>
                                  )}
                                </div>
                              </td>
                              <td className="py-3.5 pr-4 text-slate-300 group-hover:text-blue-600">
                                <ChevronRight className="w-4 h-4 mt-1.5" aria-hidden="true" />
                              </td>
                            </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                  {daily && !rows.length && <EmptyState icon={Users} title="No active employees" description="Add employees and enroll their faces to start measuring office time." />}
                  {daily && rows.length > 0 && !visible.length && (
                    <EmptyState
                      icon={Search}
                      title="Nobody matches"
                      description="Try another filter or search."
                      action={
                        <button
                          type="button"
                          className={btn.secondary}
                          onClick={() => {
                            setFilter('all');
                            setQuery('');
                          }}
                        >
                          Show everyone
                        </button>
                      }
                    />
                  )}
                </div>
              )}

              <div className="hidden lg:flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3 border-t border-slate-100 text-[11.5px] text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-2.5 rounded-sm bg-emerald-500" /> Inside
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-2.5 rounded-sm bg-amber-400" /> Away
                </span>
                {isToday && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-2.5 rounded-sm bg-[repeating-linear-gradient(135deg,#fcd34d_0_3px,#fef3c7_3px_6px)]" /> Not seen since
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-2.5 rounded-sm bg-slate-200" /> Work hours
                </span>
                {isToday && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-0.5 h-3 rounded-full bg-blue-500" /> Now
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" /> Hover a bar for exact times
                </span>
              </div>
            </Card>
          </>
        ) : (
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3">
              <div>
                <h2 className="text-[14px] font-semibold text-slate-900">
                  {history ? `${fmtDate(history.startDate, { day: 'numeric', month: 'short' })} – ${fmtDate(history.endDate)}` : 'Loading…'}
                </h2>
                <p className="text-[12.5px] text-slate-500 mt-0.5">Time inside per day. Tap a day to open it; swipe sideways for more days.</p>
              </div>
              {historyLoading && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
            </div>
            {historyError ? (
              <div className="px-5 py-6 text-[13px] text-rose-700 flex items-center gap-2 border-t border-slate-100">
                <AlertCircle className="w-4 h-4" /> {historyError}
              </div>
            ) : (
              <div className="overflow-x-auto border-t border-slate-100">
                <table className="w-full text-[12.5px]">
                  <thead className="bg-slate-50/70 text-slate-500 text-[11.5px]">
                    <tr>
                      <th className="py-2.5 pl-4 sm:pl-5 pr-3 text-left font-medium sticky left-0 bg-slate-50 min-w-[140px] sm:min-w-[200px] z-10">Employee</th>
                      {history?.dates.map((d) => {
                        const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                        const isT = d === history.today;
                        return (
                          <th key={d} className={`py-2.5 px-1.5 text-center font-medium min-w-[78px] ${wd === 0 || wd === 6 ? 'text-slate-400' : ''} ${isT ? 'text-blue-700' : ''}`}>
                            <div>{isT ? 'Today' : fmtDate(d, { weekday: 'short' })}</div>
                            <div className="text-[12px] text-slate-700 font-semibold">{fmtDate(d, { day: 'numeric', month: 'short' })}</div>
                          </th>
                        );
                      })}
                      <th className="py-2.5 px-3 text-right font-medium">Days</th>
                      <th className="py-2.5 px-3 text-right font-medium">Late</th>
                      <th className="py-2.5 px-3 text-right font-medium">Avg / day</th>
                      <th className="py-2.5 px-3 text-right font-medium">Total inside</th>
                      <th className="py-2.5 pl-3 pr-5 text-right font-medium">Total away</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {!history &&
                      [0, 1].map((i) => (
                        <tr key={i}>
                          <td colSpan={12} className="px-5 py-3">
                            <Skeleton className="h-9" />
                          </td>
                        </tr>
                      ))}
                    {history?.data.map((r: WorkPeriodRow) => (
                      <tr key={r.employee.id}>
                        <td className="py-2.5 pl-4 sm:pl-5 pr-3 sticky left-0 bg-white z-10">
                          <div className="flex items-center gap-2.5">
                            <span className="hidden sm:block">
                              <Avatar name={r.employee.fullName} id={r.employee.id} size="sm" />
                            </span>
                            <div className="min-w-0">
                              <p className="text-[13px] font-medium text-slate-900 truncate max-w-[9rem] sm:max-w-none">{r.employee.fullName}</p>
                              <p className="text-[11px] text-slate-500">{r.employee.employeeCode}</p>
                            </div>
                          </div>
                        </td>
                        {r.days.map((d) => {
                          const share = r.scheduledMinutesPerDay ? d.insideMinutes / r.scheduledMinutesPerDay : 0.5;
                          const heat = share >= 0.85 ? 'bg-emerald-100 ring-emerald-200' : share >= 0.5 ? 'bg-emerald-50 ring-emerald-100' : 'bg-lime-50/60 ring-slate-200';
                          return (
                            <td key={d.date} className="py-1.5 px-1 text-center">
                              {d.present ? (
                                <button
                                  type="button"
                                  onClick={() => openDay(d.date)}
                                  className={`w-full rounded-lg px-1.5 py-1.5 ring-1 ring-inset ${heat} hover:ring-emerald-400 transition`}
                                  title={`${fmtTime(d.firstSeen)} – ${fmtTime(d.lastSeen)} · away ${fmtMin(d.awayMinutes)} (${d.timesAway}×)${d.isLate ? ' · late' : ''}`}
                                >
                                  <div className="font-semibold text-emerald-950 tabular-nums">{fmtMin(d.insideMinutes)}</div>
                                  <div className="text-[10.5px] tabular-nums text-slate-500 whitespace-nowrap">
                                    {d.timesAway ? <span className="text-amber-800">away {fmtMin(d.awayMinutes)}</span> : 'no away'}
                                    {d.isLate && <span className="text-rose-700 font-semibold"> · late</span>}
                                  </div>
                                </button>
                              ) : (
                                <span className="text-slate-300" aria-label="Not seen">
                                  —
                                </span>
                              )}
                            </td>
                          );
                        })}
                        <td className="py-2.5 px-3 text-right tabular-nums">{r.daysPresent}</td>
                        <td className={`py-2.5 px-3 text-right tabular-nums ${r.lateDays ? 'text-rose-700 font-medium' : 'text-slate-400'}`}>{r.lateDays}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums">{fmtMin(r.avgInsideMinutes)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-slate-900">{fmtMin(r.totalInsideMinutes)}</td>
                        <td className="py-2.5 pl-3 pr-5 text-right tabular-nums text-amber-800">{fmtMin(r.totalAwayMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 sm:px-5 py-3 border-t border-slate-100 text-[11.5px] text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-2.5 rounded-sm bg-emerald-100 ring-1 ring-emerald-200" /> 85%+ of the work day inside
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-2.5 rounded-sm bg-emerald-50 ring-1 ring-emerald-100" /> 50–85%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-2.5 rounded-sm bg-lime-50 ring-1 ring-slate-200" /> under 50%
              </span>
              <span>— not seen that day</span>
            </div>
          </Card>
        )}
      </main>
    </>
  );
}
