'use client';

/** Building blocks shared by the Office Time list and the per-employee Office Time page. */

import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PresenceBadge, PresenceTone, Skeleton, Tag } from '@/components/ui';
import { workHoursApi, Sighting, WorkDayRow } from '@/lib/api';
import { fmtDur, fmtMin, fmtTime, timeAgo } from '@/lib/format';

export const LONG_AWAY_SEC = 15 * 60; // away periods this long are highlighted
const HOUR = 3600_000;

export const ms = (iso: string) => new Date(iso).getTime();

/** Same wording as the Overview page. */
export function presenceOf(r: WorkDayRow, isToday: boolean): { tone: PresenceTone; label: string; order: number } {
  if (r.state === 'IN_OFFICE') return { tone: 'in', label: 'In office', order: 0 };
  if (r.state === 'LEFT') return isToday ? { tone: 'away', label: 'Not seen now', order: 1 } : { tone: 'present', label: 'Was in', order: 1 };
  return { tone: 'out', label: isToday ? 'Not in yet' : 'Absent', order: 2 };
}

export function pctOfSchedule(r: WorkDayRow) {
  return r.scheduledMinutes ? Math.min(100, Math.round((r.insideSeconds / 60 / r.scheduledMinutes) * 100)) : null;
}

/** Window covering the schedule, every sighting, and "now" (today), snapped to whole hours. */
export function timeWindow(rows: WorkDayRow[], isToday: boolean, now: number) {
  const pts: number[] = [];
  for (const r of rows) {
    if (r.sessions.length) pts.push(ms(r.sessions[0].start), ms(r.sessions[r.sessions.length - 1].end));
    if (r.schedule && (r.sessions.length || !isToday)) pts.push(ms(r.schedule.startAt), ms(r.schedule.endAt));
  }
  if (!pts.length) return null;
  let start = Math.min(...pts);
  let end = Math.max(...pts);
  if (isToday) end = Math.max(end, now);
  start = Math.floor(start / HOUR) * HOUR;
  end = Math.max(start + HOUR, Math.ceil(end / HOUR) * HOUR);
  return { start, end };
}

function hourTicks(start: number, end: number, maxTicks = 9) {
  const hours = Math.round((end - start) / HOUR);
  const step = Math.max(1, Math.ceil(hours / maxTicks));
  const out: number[] = [];
  for (let t = start; t <= end; t += step * HOUR) out.push(t);
  return out;
}

const tickLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric' }).replace(':00', '');

// ------------------------------------------------------------------ timeline

export function TimeAxis({ start, end, className = '' }: { start: number; end: number; className?: string }) {
  const span = end - start;
  return (
    <div className={`relative h-4 ${className}`} aria-hidden="true">
      {hourTicks(start, end).map((t, i, arr) => (
        <span
          key={t}
          className={`absolute top-0 text-[10.5px] font-normal normal-case tracking-normal text-slate-400 tabular-nums whitespace-nowrap ${
            i === 0 ? '' : i === arr.length - 1 ? '-translate-x-full' : '-translate-x-1/2'
          }`}
          style={{ left: `${((t - start) / span) * 100}%` }}
        >
          {tickLabel(t)}
        </span>
      ))}
    </div>
  );
}

/** One timeline stretch with a hover/focus label. */
function Segment({ style, cls, label, focusable }: { style: React.CSSProperties; cls: string; label: string; focusable: boolean }) {
  return (
    <span className={`group/seg absolute inset-y-0 ${cls}`} style={style} tabIndex={focusable ? 0 : -1} aria-label={label}>
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover/seg:block group-focus/seg:block z-20 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white shadow-lg">
        {label}
      </span>
    </span>
  );
}

/**
 * One person's day on a shared window: work hours as a pale band, inside green, away amber, a "now" line today.
 * Every segment has a hover/focus label, so nothing depends on colour alone.
 */
export function TimelineBar({
  row,
  start,
  end,
  now,
  isToday,
  size = 'md',
}: {
  row: WorkDayRow;
  start: number;
  end: number;
  now: number;
  isToday: boolean;
  size?: 'md' | 'lg';
}) {
  const span = Math.max(1, end - start);
  const pos = (t: number) => Math.min(100, Math.max(0, ((t - start) / span) * 100));
  const seg = (a: number, b: number) => ({ left: `${pos(a)}%`, width: `${Math.max(0.7, pos(b) - pos(a))}%` });
  const h = size === 'lg' ? 'h-7' : 'h-3.5';
  const last = row.sessions.length ? ms(row.sessions[row.sessions.length - 1].end) : null;
  const notSeenTail = isToday && row.state === 'LEFT' && last !== null && now > last;

  const focusable = size === 'lg';

  return (
    <div className={`relative ${h} rounded-md bg-slate-100`}>
      {row.schedule && (
        <span
          className="absolute inset-y-0 bg-slate-200/70 rounded-md"
          style={seg(ms(row.schedule.startAt), ms(row.schedule.endAt))}
          title={`Work hours ${row.schedule.start}–${row.schedule.end}`}
          aria-hidden="true"
        />
      )}
      {row.awayPeriods.map((p, i) => (
        <Segment
          key={`a${i}`}
          style={seg(ms(p.start), ms(p.end))}
          focusable={focusable}
          cls={p.seconds >= LONG_AWAY_SEC ? 'bg-amber-500' : 'bg-amber-400'}
          label={`Away ${fmtTime(p.start)} – ${fmtTime(p.end)} · ${fmtDur(p.seconds)}`}
        />
      ))}
      {notSeenTail && (
        <Segment
          style={seg(last!, now)}
          focusable={focusable}
          cls="bg-[repeating-linear-gradient(135deg,#fcd34d_0_4px,#fef3c7_4px_8px)]"
          label={`Not seen since ${fmtTime(new Date(last!).toISOString())} · ${fmtDur((now - last!) / 1000)} so far`}
        />
      )}
      {row.sessions.map((s, i) => (
        <Segment
          key={`s${i}`}
          style={seg(ms(s.start), ms(s.end))}
          focusable={focusable}
          cls="bg-emerald-500 rounded-[3px]"
          label={`Inside ${fmtTime(s.start)} – ${fmtTime(s.end)} · ${fmtDur(s.seconds)}`}
        />
      ))}
      {isToday && now > start && now < end && (
        <span className="absolute -inset-y-1 w-0.5 bg-blue-500 rounded-full z-10" style={{ left: `${pos(now)}%` }} title="Now" aria-hidden="true" />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ row pieces

export function StatusCell({ row, isToday, now }: { row: WorkDayRow; isToday: boolean; now: number }) {
  const p = presenceOf(row, isToday);
  let sub: string | null = null;
  if (isToday && row.state === 'IN_OFFICE' && row.lastSeen) sub = `Seen ${timeAgo(row.lastSeen, now)}`;
  else if (isToday && row.state === 'LEFT' && row.lastSeen) sub = `For ${fmtDur((now - ms(row.lastSeen)) / 1000)} · since ${fmtTime(row.lastSeen)}`;
  else if (!isToday && row.state === 'LEFT' && row.lastSeen) sub = `Last seen ${fmtTime(row.lastSeen)}`;
  else if (row.state === 'ABSENT' && isToday && row.schedule) sub = `Due ${fmtTime(row.schedule.startAt)}`;
  return (
    <div className="space-y-1">
      <PresenceBadge tone={p.tone}>{p.label}</PresenceBadge>
      {sub && <p className="text-[11.5px] text-slate-500 tabular-nums whitespace-nowrap">{sub}</p>}
    </div>
  );
}

export function ArrivalCell({ row }: { row: WorkDayRow }) {
  const first = row.firstSeen ?? row.checkIn;
  if (!first) return <span className="text-slate-300">—</span>;
  return (
    <div className="space-y-1">
      <p className="text-[13px] font-medium text-slate-800 tabular-nums">{fmtTime(first)}</p>
      {row.isLate ? (
        <span
          className="inline-flex items-center h-5 px-1.5 rounded-md text-[11px] font-semibold bg-rose-50 text-rose-700 whitespace-nowrap"
          title={row.schedule ? `Work starts ${row.schedule.start} (${row.schedule.graceMinutes} min grace)` : undefined}
        >
          Late{row.lateByMinutes ? ` · ${fmtMin(row.lateByMinutes)}` : ''}
        </span>
      ) : (
        <span className="text-[11.5px] text-emerald-700">On time</span>
      )}
    </div>
  );
}

export function InsideCell({ row }: { row: WorkDayRow }) {
  if (!row.date) return <span className="text-slate-300">—</span>;
  const pct = pctOfSchedule(row);
  return (
    <div className="md:min-w-[96px]">
      <p className="text-[14px] font-semibold text-slate-900 tabular-nums">{fmtDur(row.insideSeconds)}</p>
      {pct !== null && (
        <div className="mt-1.5 flex items-center gap-2" title={`${pct}% of the ${fmtMin(row.scheduledMinutes!)} work day`}>
          <div className="h-1 flex-1 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] text-slate-500 tabular-nums">{pct}%</span>
        </div>
      )}
    </div>
  );
}

export function AwayCell({ row }: { row: WorkDayRow }) {
  if (!row.date) return <span className="text-slate-300">—</span>;
  if (!row.awayPeriods.length) return <span className="text-[12.5px] text-slate-400">None</span>;
  return (
    <div>
      <p className="text-[13px] font-semibold text-amber-800 tabular-nums">
        {fmtDur(row.awaySeconds)} <span className="font-normal text-slate-500">· {row.awayPeriods.length}×</span>
      </p>
      <p className="text-[11.5px] text-slate-500 tabular-nums whitespace-nowrap">Longest {fmtDur(row.longestAwaySeconds)}</p>
    </div>
  );
}

export function Kpi({ label, value, sub, tone = 'slate' }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'slate' | 'amber' | 'rose' }) {
  const color = tone === 'amber' ? 'text-amber-800' : tone === 'rose' ? 'text-rose-700' : 'text-slate-900';
  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200/70 px-3.5 py-3">
      <p className="text-[11.5px] font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-[16px] font-semibold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11.5px] text-slate-500 tabular-nums">{sub}</p>}
    </div>
  );
}


// ------------------------------------------------------------------ one person's day (employee page)

/** Big timeline for one person, with a live "in the office now / not seen for" line today. */
export function DayGlance({ row, isToday, now }: { row: WorkDayRow; isToday: boolean; now: number }) {
  const win = timeWindow([row], isToday, now);
  const notSeenFor = isToday && row.state === 'LEFT' && row.lastSeen ? (now - ms(row.lastSeen)) / 1000 : 0;
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200/70 px-4 sm:px-5 pt-4 pb-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-3">
        <h2 className="text-[14px] font-semibold text-slate-900">Day at a glance</h2>
        {row.schedule && (
          <span className="text-[12px] text-slate-500">
            Work hours {row.schedule.start}–{row.schedule.end}
          </span>
        )}
      </div>
      {win ? (
        <>
          <TimeAxis start={win.start} end={win.end} className="mb-1.5" />
          <TimelineBar row={row} start={win.start} end={win.end} now={now} isToday={isToday} size="lg" />
        </>
      ) : (
        <p className="text-[12.5px] text-slate-500">Not seen by a camera on this day.</p>
      )}
      {isToday && row.state === 'IN_OFFICE' && (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] font-medium text-emerald-700">
          <Eye className="w-3.5 h-3.5" /> In the office now · last seen {timeAgo(row.lastSeen, now)}
        </p>
      )}
      {notSeenFor > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-amber-800">
          <EyeOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <b className="font-medium">Not seen for {fmtDur(notSeenFor)}</b> (since {fmtTime(row.lastSeen, true)}). It becomes an away period if they come
            back; if not, their day ends at the last sighting.
          </span>
        </p>
      )}
    </div>
  );
}

export function DayKpis({ row, isToday }: { row: WorkDayRow; isToday: boolean }) {
  const pct = pctOfSchedule(row);
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Kpi
        label="Arrived"
        value={fmtTime(row.firstSeen ?? row.checkIn)}
        sub={row.isLate ? `Late by ${fmtMin(row.lateByMinutes)}` : row.schedule ? `On time (${row.schedule.start})` : undefined}
        tone={row.isLate ? 'rose' : 'slate'}
      />
      <Kpi
        label={isToday && row.state === 'IN_OFFICE' ? 'Last seen' : 'Left / last seen'}
        value={fmtTime(row.lastSeen)}
        sub={`${fmtMin(row.spanMinutes)} after arriving`}
      />
      <Kpi label="Inside" value={fmtDur(row.insideSeconds)} sub={pct !== null ? `${pct}% of ${fmtMin(row.scheduledMinutes!)}` : undefined} />
      <Kpi
        label="Away"
        value={row.awayPeriods.length ? fmtDur(row.awaySeconds) : 'None'}
        sub={row.awayPeriods.length ? `${row.awayPeriods.length}× · longest ${fmtDur(row.longestAwaySeconds)}` : undefined}
        tone={row.awayPeriods.length ? 'amber' : 'slate'}
      />
    </div>
  );
}

export function AwayPeriodsCard({ row, gap }: { row: WorkDayRow; gap: number }) {
  const longAways = row.awayPeriods.filter((p) => p.seconds >= LONG_AWAY_SEC).length;
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200/70">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 sm:px-5 py-3 border-b border-slate-100">
        <h2 className="text-[14px] font-semibold text-slate-900">Away periods</h2>
        <span className="text-[12px] text-slate-500">
          Unseen for over {gap} min{longAways ? ` · ${longAways} over ${LONG_AWAY_SEC / 60} min` : ''}
        </span>
      </div>
      {row.awayPeriods.length ? (
        <ul className="divide-y divide-slate-100">
          {row.awayPeriods.map((p, i) => {
            const long = p.seconds >= LONG_AWAY_SEC;
            return (
              <li key={i} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-2.5">
                <span className="flex items-center gap-2.5 text-[13px] text-slate-700 tabular-nums">
                  <span className={`w-2 h-2 rounded-full ${long ? 'bg-amber-500' : 'bg-amber-300'}`} aria-hidden="true" />
                  {fmtTime(p.start)} → {fmtTime(p.end)}
                </span>
                <span
                  className={`inline-flex items-center h-5 px-2 rounded-full text-[11.5px] font-medium tabular-nums ${
                    long ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {fmtDur(p.seconds)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-5 py-4 text-[12.5px] text-slate-500">No away periods: seen continuously since arriving.</p>
      )}
    </div>
  );
}

/** Every face sighting of one person on one day, newest first, with gap markers. Refetches when the count changes. */
export function SightingsCard({ employeeId, date, count, gap }: { employeeId: string; date: string; count: number; gap: number }) {
  const [sightings, setSightings] = useState<Sighting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    workHoursApi
      .sightings(employeeId, date)
      .then((res) => alive && (setSightings(res.data), setError(null)))
      .catch((e: any) => alive && setError(e.message || 'Could not load sightings'));
    return () => {
      alive = false;
    };
  }, [employeeId, date, count]);

  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200/70 flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h2 className="text-[14px] font-semibold text-slate-900">Face sightings</h2>
        <span className="text-[12px] text-slate-500">{count} on this day</span>
      </div>
      {error ? (
        <p className="px-5 py-4 text-[12.5px] text-rose-700">{error}</p>
      ) : !sightings ? (
        <div className="p-5 space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-5" />
          ))}
        </div>
      ) : !sightings.length ? (
        <p className="px-5 py-4 text-[12.5px] text-slate-500">No face sightings on this day.</p>
      ) : (
        <div className="max-h-[32rem] overflow-y-auto">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-white text-slate-500 text-[11.5px]">
              <tr className="border-b border-slate-100">
                <th className="text-left font-medium px-5 py-2">Time</th>
                <th className="text-left font-medium px-2 py-2">Lens</th>
                <th className="text-right font-medium px-5 py-2">Match</th>
              </tr>
            </thead>
            <tbody>
              {[...sightings].reverse().map((s, i, arr) => {
                const older = arr[i + 1];
                const gapSec = older ? (ms(s.seenAt) - ms(older.seenAt)) / 1000 : 0;
                return (
                  <React.Fragment key={`${s.seenAt}-${i}`}>
                    <tr className="border-t border-slate-50">
                      <td className="px-5 py-1.5 tabular-nums text-slate-700 whitespace-nowrap">
                        {fmtTime(s.seenAt, true)}
                        {s.action === 'CHECK_IN' && (
                          <span className="ml-1.5">
                            <Tag tone="blue">Arrived</Tag>
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">Lens {s.channelNo}</td>
                      <td className="px-5 py-1.5 text-right tabular-nums">
                        <span className={s.similarity >= 0.6 ? 'text-emerald-700' : 'text-slate-500'}>{Math.round(s.similarity * 100)}%</span>
                      </td>
                    </tr>
                    {gapSec > gap * 60 && (
                      <tr>
                        <td colSpan={3} className="px-5 py-1 bg-amber-50/70 text-[11.5px] text-amber-800">
                          No face for {fmtDur(gapSec)}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-auto px-5 py-3 border-t border-slate-100 text-[11.5px] text-slate-500">
        Newest first. Gaps between face sightings don&apos;t count as away while body tracking still follows the person.
      </p>
    </div>
  );
}
