'use client';

/**
 * One employee's office time for one day (?date=YYYY-MM-DD, default today): timeline, key numbers,
 * away periods, every face sighting, and their last 7 days for context.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, CalendarClock, ChevronLeft, ChevronRight, RefreshCw, UserX } from 'lucide-react';
import { Header } from '@/components/Header';
import { Avatar, btn, Card, EmptyState, Skeleton } from '@/components/ui';
import { AwayPeriodsCard, DayGlance, DayKpis, SightingsCard, StatusCell } from '@/components/officeTime';
import { workHoursApi, WorkDayRow, WorkPeriodRow } from '@/lib/api';
import { DEFAULT_GAP, fmtDate, fmtMin, fmtTime, readGap, shiftDate, timeAgo } from '@/lib/format';

type DailyRes = Awaited<ReturnType<typeof workHoursApi.daily>>;

const TREND_DAYS = 7;

export default function EmployeeOfficeTimeRoute() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <React.Suspense fallback={<Header title="Office time" />}>
      <EmployeeOfficeTime />
    </React.Suspense>
  );
}

function EmployeeOfficeTime() {
  const { employeeId } = useParams<{ employeeId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const date = searchParams.get('date'); // null = today

  const [gapChoice, setGapChoice] = useState<number | null | undefined>(undefined); // undefined = not read yet
  const [daily, setDaily] = useState<DailyRes | null>(null);
  const [trend, setTrend] = useState<WorkPeriodRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setGapChoice(readGap()), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (gapChoice === undefined) return;
      if (!silent) setLoading(true);
      try {
        const res = await workHoursApi.daily(date ?? undefined, gapChoice ?? undefined);
        setDaily(res);
        setError(null);
        setUpdatedAt(Date.now());
        setNow(Date.now());
        workHoursApi
          .summary(shiftDate(res.date, -(TREND_DAYS - 1)), res.date, gapChoice ?? undefined)
          .then((s) => setTrend(s.data.find((r) => r.employee.id === employeeId) ?? null))
          .catch(() => setTrend(null));
      } catch (e: any) {
        if (!silent) setError(e.message || 'Could not load office time');
      } finally {
        setLoading(false);
      }
    },
    [date, gapChoice, employeeId]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live refresh while looking at today
  useEffect(() => {
    if (!daily?.isToday) return;
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [daily?.isToday, load]);

  const row: WorkDayRow | undefined = useMemo(() => daily?.data.find((r) => r.employee.id === employeeId), [daily, employeeId]);
  const isToday = !!daily?.isToday;
  const shownDate = daily?.date ?? date;
  const gap = daily?.settings.presenceGapMin ?? DEFAULT_GAP;

  const goTo = (d: string | null) => {
    const target = d && daily && d >= daily.today ? null : d;
    router.push(`/dashboard/office-time/${employeeId}${target ? `?date=${target}` : ''}`, { scroll: false });
  };
  const backHref = `/dashboard/office-time${date ? `?date=${date}` : ''}`;

  const trendStats = useMemo(() => {
    if (!trend) return null;
    const present = trend.days.filter((d) => d.present);
    return {
      present: present.length,
      late: trend.lateDays,
      avgInside: trend.avgInsideMinutes,
      avgAway: present.length ? Math.round(trend.totalAwayMinutes / present.length) : 0,
      sched: trend.scheduledMinutesPerDay,
    };
  }, [trend]);

  return (
    <>
      <Header title={row?.employee.fullName ?? 'Office time'} subtitle={row ? `Office time · ${row.employee.employeeCode}` : 'Office time'} />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-5 max-w-[1440px] w-full mx-auto">
        {/* Toolbar: pinned under the page header (h-16) while the page scrolls */}
        <div className="sticky top-16 z-20 -mx-4 sm:-mx-6 lg:-mx-8 -mt-6 px-4 sm:px-6 lg:px-8 py-3 bg-[#f6f7f9]/90 backdrop-blur-md border-b border-slate-200/70 flex flex-wrap items-center justify-between gap-3">
          <Link href={backHref} className={`${btn.secondary} max-sm:!px-2.5`} aria-label="All employees">
            <ArrowLeft className="w-4 h-4" /> <span className="hidden sm:inline">All employees</span>
          </Link>
          <div className="flex flex-wrap items-center gap-1.5">
            {isToday && (
              <button
                type="button"
                onClick={() => load()}
                className="inline-flex items-center gap-1.5 h-9 px-2.5 sm:mr-1 rounded-lg text-[12.5px] text-slate-500 hover:text-slate-800 hover:bg-white"
                title="Refreshes every 30 seconds"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{updatedAt ? `Updated ${timeAgo(new Date(updatedAt).toISOString(), now)}` : 'Live'}</span>
                <span className="sr-only sm:hidden">Refresh</span>
              </button>
            )}
            <button type="button" onClick={() => shownDate && goTo(shiftDate(shownDate, -1))} className={`${btn.secondary} !px-2.5`} aria-label="Previous day">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <label>
              <span className="sr-only">Date</span>
              <input
                type="date"
                value={shownDate ?? ''}
                max={daily?.today}
                onChange={(e) => e.target.value && goTo(e.target.value)}
                className="h-9 px-3 rounded-lg bg-white ring-1 ring-inset ring-slate-200 text-[13px] font-medium text-slate-700 shadow-sm border-0"
              />
            </label>
            <button
              type="button"
              onClick={() => shownDate && goTo(shiftDate(shownDate, 1))}
              disabled={isToday || !daily}
              className={`${btn.secondary} !px-2.5`}
              aria-label="Next day"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            {!isToday && daily && (
              <button type="button" onClick={() => goTo(null)} className={btn.secondary}>
                Today
              </button>
            )}
          </div>
        </div>

        {error ? (
          <Card className="px-5 py-6 text-[13px] text-rose-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
            <button type="button" onClick={() => load()} className={`${btn.secondary} ml-2`}>
              Try again
            </button>
          </Card>
        ) : !daily ? (
          <div className="space-y-4">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-64 rounded-2xl" />
          </div>
        ) : !row ? (
          <Card>
            <EmptyState
              icon={UserX}
              title="Employee not found"
              description="They may have been removed or deactivated. Only active employees have office time."
              action={
                <Link href={backHref} className={btn.secondary}>
                  Back to all employees
                </Link>
              }
            />
          </Card>
        ) : (
          <>
            {/* Person */}
            <Card className="px-4 sm:px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3.5 min-w-0">
                  <span className="scale-125 origin-left mr-2">
                    <Avatar name={row.employee.fullName} id={row.employee.id} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[16px] font-semibold text-slate-900 truncate">{row.employee.fullName}</p>
                    <p className="text-[12.5px] text-slate-500 truncate">
                      {[row.employee.employeeCode, row.employee.jobTitle, row.employee.department].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                  <div>
                    <p className="text-[11.5px] text-slate-500 mb-1">{fmtDate(daily.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                    <StatusCell row={row} isToday={isToday} now={now} />
                  </div>
                  {row.schedule && (
                    <div className="text-[12.5px] text-slate-600">
                      <p className="text-[11.5px] text-slate-500 mb-1">Work schedule</p>
                      <p className="flex items-center gap-1.5 font-medium text-slate-800">
                        <CalendarClock className="w-4 h-4 text-slate-400" /> {row.schedule.start}–{row.schedule.end}
                      </p>
                      <p className="text-[11.5px] text-slate-500">{row.schedule.graceMinutes} min grace</p>
                    </div>
                  )}
                </div>
              </div>
            </Card>

            {row.date ? (
              <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 sm:gap-5 items-start">
                <div className="xl:col-span-3 space-y-4 sm:space-y-5 min-w-0">
                  <DayGlance row={row} isToday={isToday} now={now} />
                  <DayKpis row={row} isToday={isToday} />
                  <AwayPeriodsCard row={row} gap={gap} />
                </div>
                <div className="xl:col-span-2 min-w-0">
                  <SightingsCard employeeId={row.employee.id} date={daily.date} count={row.sightings} gap={gap} />
                </div>
              </div>
            ) : (
              <Card>
                <EmptyState
                  icon={CalendarClock}
                  title={isToday ? 'Not in yet today' : 'Not seen on this day'}
                  description={
                    isToday && row.schedule
                      ? `Work starts at ${fmtTime(row.schedule.startAt)}. Their day appears here as soon as a camera recognises them.`
                      : 'No camera recognised them on this day.'
                  }
                />
              </Card>
            )}

            {/* Last 7 days */}
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3">
                <div>
                  <h2 className="text-[14px] font-semibold text-slate-900">Last {TREND_DAYS} days</h2>
                  <p className="text-[12.5px] text-slate-500 mt-0.5">Up to {fmtDate(daily.date, { day: 'numeric', month: 'short' })}. Click a day to open it.</p>
                </div>
                {trendStats && (
                  <dl className="grid grid-cols-4 sm:flex sm:flex-wrap gap-x-4 sm:gap-x-6 gap-y-1 text-[12.5px] w-full sm:w-auto">
                    <div>
                      <dt className="text-slate-500">Days in</dt>
                      <dd className="font-semibold text-slate-900 tabular-nums">
                        {trendStats.present} / {TREND_DAYS}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Late</dt>
                      <dd className={`font-semibold tabular-nums ${trendStats.late ? 'text-rose-700' : 'text-slate-900'}`}>{trendStats.late}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Avg inside</dt>
                      <dd className="font-semibold text-slate-900 tabular-nums">{fmtMin(trendStats.avgInside)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Avg away</dt>
                      <dd className="font-semibold text-amber-800 tabular-nums">{fmtMin(trendStats.avgAway)}</dd>
                    </div>
                  </dl>
                )}
              </div>
              <div className="sm:overflow-x-auto">
              <div className="grid grid-cols-4 sm:grid-cols-7 gap-2 px-4 sm:px-5 pb-5 sm:min-w-[600px]">
                {!trend
                  ? Array.from({ length: TREND_DAYS }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)
                  : trend.days.map((d) => {
                      const selected = d.date === daily.date;
                      const wd = new Date(`${d.date}T00:00:00Z`).getUTCDay();
                      const share = trend.scheduledMinutesPerDay ? Math.min(1, d.insideMinutes / trend.scheduledMinutesPerDay) : 0;
                      return (
                        <button
                          key={d.date}
                          type="button"
                          onClick={() => goTo(d.date)}
                          aria-current={selected ? 'date' : undefined}
                          className={`rounded-xl px-2 py-2.5 text-left ring-1 ring-inset transition ${
                            selected ? 'ring-2 ring-blue-500 bg-blue-50/40' : 'ring-slate-200 hover:ring-slate-300 hover:bg-slate-50'
                          }`}
                          title={d.present ? `${fmtTime(d.firstSeen)} – ${fmtTime(d.lastSeen)} · away ${fmtMin(d.awayMinutes)} (${d.timesAway}×)` : 'Not seen'}
                        >
                          <p className={`text-[11px] ${wd === 0 || wd === 6 ? 'text-slate-400' : 'text-slate-500'}`}>
                            {d.date === daily.today ? 'Today' : fmtDate(d.date, { weekday: 'short' })} {fmtDate(d.date, { day: 'numeric' })}
                          </p>
                          {d.present ? (
                            <>
                              <p className="mt-1 text-[13.5px] font-semibold text-slate-900 tabular-nums">{fmtMin(d.insideMinutes)}</p>
                              <div className="mt-1.5 h-1 rounded-full bg-slate-100 overflow-hidden">
                                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(share * 100)}%` }} />
                              </div>
                              <p className="mt-1.5 text-[10.5px] tabular-nums truncate">
                                {d.isLate ? <span className="text-rose-700 font-semibold">Late</span> : <span className="text-slate-500">On time</span>}
                                {d.timesAway ? <span className="text-amber-800"> · away {fmtMin(d.awayMinutes)}</span> : null}
                              </p>
                            </>
                          ) : (
                            <p className="mt-1 text-[12.5px] text-slate-300">—</p>
                          )}
                        </button>
                      );
                    })}
              </div>
              </div>
            </Card>
          </>
        )}
      </main>
    </>
  );
}
