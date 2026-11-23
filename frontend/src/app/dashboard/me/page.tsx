'use client';

/** My time: the signed-in person's own office time and attendance (the only page an Employee account sees). */

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, DoorOpen, LogIn, UserX } from 'lucide-react';
import { Header } from '@/components/Header';
import { Card, CardHeader, EmptyState, PresenceBadge, Skeleton, StatTile, Tag, btn } from '@/components/ui';
import { Notice } from '@/components/settings/parts';
import { useShell } from '@/components/shell/ShellContext';
import { meApi, type MyOfficeTime } from '@/lib/api';
import { fmtDate, fmtDur, fmtMin, fmtTime, greeting, shiftDate } from '@/lib/format';

export default function MyTimePage() {
  const { user } = useShell();
  const [date, setDate] = useState<string | null>(null); // null = today
  const [data, setData] = useState<MyOfficeTime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await meApi.officeTime(date ?? undefined, 14);
      setData(res);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Could not load your office time');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    load();
    if (date) return;
    const t = setInterval(load, 60000); // today keeps updating
    return () => clearInterval(t);
  }, [load, date]);

  if (user && !user.employee) {
    return (
      <>
        <Header title="My time" />
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-[1440px] w-full mx-auto">
          <Card>
            <EmptyState icon={UserX} title="Your login isn't linked to an employee record" description="Ask an admin to link it in Users & access." />
          </Card>
        </main>
      </>
    );
  }

  const day = data?.day;
  const state = !day || !day.date ? 'out' : data?.isToday && day.state === 'IN_OFFICE' ? 'in' : day.state === 'ABSENT' ? 'out' : 'present';
  const stateText = !day || !day.date ? (data?.isToday ? 'Not in yet' : 'Not in') : data?.isToday && day.state === 'IN_OFFICE' ? 'In the office' : data?.isToday ? 'Left the office' : 'Came in';

  return (
    <>
      <Header title="My time" subtitle={user ? `${greeting()}, ${user.employee?.fullName ?? user.fullName}` : ''} />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] w-full mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={btn.secondary}
              onClick={() => data && setDate(shiftDate(data.date, -1))}
              disabled={!data}
              aria-label="Previous day"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <p className="text-[14px] font-medium text-slate-900 min-w-[12rem] text-center">
              {data ? (data.isToday ? `Today, ${fmtDate(data.date, { day: 'numeric', month: 'long' })}` : fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long' })) : '…'}
            </p>
            <button
              type="button"
              className={btn.secondary}
              onClick={() => data && setDate(shiftDate(data.date, 1) >= data.today ? null : shiftDate(data.date, 1))}
              disabled={!data || data.isToday}
              aria-label="Next day"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {data && !data.isToday && (
            <button type="button" className={btn.ghost} onClick={() => setDate(null)}>
              Back to today
            </button>
          )}
        </div>

        {error && <Notice tone="error">{error}</Notice>}

        {loading && !data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
        ) : (
          data &&
          day && (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile label="Status" value={<PresenceBadge tone={state}>{stateText}</PresenceBadge>} sub={day.isLate ? 'Arrived late' : day.date ? 'On time' : ' '} />
                <StatTile label="Arrived" icon={LogIn} value={day.date ? fmtTime(day.firstSeen ?? day.checkIn) : '—'} sub={day.lastSeen ? `Last seen ${fmtTime(day.lastSeen)}` : undefined} />
                <StatTile label="Time inside" icon={Clock} value={day.date ? fmtDur(day.insideSeconds) : '—'} sub={day.scheduledMinutes ? `Schedule ${fmtMin(day.scheduledMinutes)}` : undefined} />
                <StatTile
                  label="Time away"
                  icon={DoorOpen}
                  value={day.date ? fmtDur(day.awaySeconds) : '—'}
                  sub={day.awayPeriods.length ? `${day.awayPeriods.length} time${day.awayPeriods.length === 1 ? '' : 's'}, over ${data.awayAfterMin} min each` : 'Not counted as away'}
                />
              </div>

              {day.date && (day.sessions.length > 0 || day.awayPeriods.length > 0) && (
                <Card>
                  <CardHeader title="The day" description={`Not being seen by a camera for more than ${data.awayAfterMin} minutes counts as away.`} />
                  <ol className="px-5 pb-5 space-y-2">
                    {day.sessions.flatMap((s, i) => {
                      const rows = [
                        <li key={`s${i}`} className="flex items-center gap-3 text-[13px]">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
                          <span className="tabular-nums text-slate-900 w-36 shrink-0">
                            {fmtTime(s.start)} – {fmtTime(s.end)}
                          </span>
                          <span className="text-slate-600">In the office · {fmtDur(s.seconds)}</span>
                        </li>,
                      ];
                      const away = day.awayPeriods[i];
                      if (away)
                        rows.push(
                          <li key={`a${i}`} className="flex items-center gap-3 text-[13px]">
                            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                            <span className="tabular-nums text-slate-900 w-36 shrink-0">
                              {fmtTime(away.start)} – {fmtTime(away.end)}
                            </span>
                            <span className="text-slate-600">Away · {fmtDur(away.seconds)}</span>
                          </li>
                        );
                      return rows;
                    })}
                  </ol>
                </Card>
              )}

              <Card>
                <CardHeader
                  title="Last 14 days"
                  description={`${data.summary.daysPresent} day${data.summary.daysPresent === 1 ? '' : 's'} in · average ${fmtMin(data.summary.avgInsideMinutes)} inside${
                    data.summary.lateDays ? ` · late ${data.summary.lateDays} time${data.summary.lateDays === 1 ? '' : 's'}` : ''
                  }`}
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="text-left text-[12px] text-slate-500 border-y border-slate-100 bg-slate-50/60">
                        <th className="font-medium py-2.5 pl-5 pr-3">Day</th>
                        <th className="font-medium py-2.5 px-3">Arrived</th>
                        <th className="font-medium py-2.5 px-3 hidden sm:table-cell">Last seen</th>
                        <th className="font-medium py-2.5 px-3 text-right">Inside</th>
                        <th className="font-medium py-2.5 pl-3 pr-5 text-right hidden sm:table-cell">Away</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.history.map((h) => (
                        <tr
                          key={h.date}
                          className={`cursor-pointer hover:bg-slate-50 ${h.date === data.date ? 'bg-blue-50/40' : ''} ${h.present ? '' : 'text-slate-400'}`}
                          onClick={() => setDate(h.date === data.today ? null : h.date)}
                        >
                          <td className="py-2.5 pl-5 pr-3 whitespace-nowrap">
                            <span className="inline-flex items-center gap-2">
                              <CalendarDays className="w-3.5 h-3.5 text-slate-400" />
                              {fmtDate(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                              {h.isLate && <Tag tone="rose">Late</Tag>}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 tabular-nums">{h.present ? fmtTime(h.firstSeen) : 'Not in'}</td>
                          <td className="py-2.5 px-3 tabular-nums hidden sm:table-cell">{h.present ? fmtTime(h.lastSeen) : ''}</td>
                          <td className="py-2.5 px-3 tabular-nums text-right">{h.present ? fmtMin(h.insideMinutes) : '—'}</td>
                          <td className="py-2.5 pl-3 pr-5 tabular-nums text-right hidden sm:table-cell">{h.present ? fmtMin(h.awayMinutes) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )
        )}
      </main>
    </>
  );
}
