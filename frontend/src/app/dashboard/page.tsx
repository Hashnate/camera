'use client';

/**
 * Overview: who is in right now, how today is going, camera health and the week, using only
 * live data (Office Time presence, recognition events, recognition status). No placeholder figures.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Cctv,
  CheckCircle2,
  Circle,
  Clock,
  DoorOpen,
  Footprints,
  ScanFace,
  Timer,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { api, RecognitionEvent, WorkDayRow, workHoursApi } from '@/lib/api';
import { useShell } from '@/components/shell/ShellContext';
import { Avatar, Card, CardHeader, CardLink, EmptyState, PresenceBadge, PresenceTone, Skeleton, StatTile, Tag, btn } from '@/components/ui';
import { WeekChart, WeekPoint } from '@/components/WeekChart';
import { fmtDate, fmtDur, fmtMin, fmtTime, readGap, shiftDate, timeAgo } from '@/lib/format';

type Daily = Awaited<ReturnType<typeof workHoursApi.daily>>;

const STATUS = { in: '#0ca30c', away: '#fab219', out: '#d9dce1' }; // status palette (good / warning) + neutral

function presenceOf(r: WorkDayRow, isToday: boolean): { tone: PresenceTone; label: string; order: number } {
  if (r.state === 'IN_OFFICE') return { tone: 'in', label: 'In office', order: 0 };
  if (r.state === 'LEFT') return isToday ? { tone: 'away', label: 'Not seen now', order: 1 } : { tone: 'present', label: 'Was in', order: 1 };
  return { tone: 'out', label: isToday ? 'Not in yet' : 'Absent', order: 2 };
}

/** Thin inside/away strip for one person on a shared time window. */
function DayStrip({ row, start, end }: { row: WorkDayRow; start: number; end: number }) {
  const span = Math.max(1, end - start);
  const pct = (iso: string) => ((new Date(iso).getTime() - start) / span) * 100;
  return (
    <div className="relative h-1.5 rounded-full bg-slate-100 overflow-hidden" aria-hidden="true">
      {row.awayPeriods.map((p, i) => (
        <span key={`a${i}`} className="absolute inset-y-0" style={{ left: `${pct(p.start)}%`, width: `${Math.max(0.8, pct(p.end) - pct(p.start))}%`, background: STATUS.away }} />
      ))}
      {row.sessions.map((s, i) => (
        <span key={`s${i}`} className="absolute inset-y-0 rounded-full" style={{ left: `${pct(s.start)}%`, width: `${Math.max(0.8, pct(s.end) - pct(s.start))}%`, background: STATUS.in }} />
      ))}
    </div>
  );
}

const EVENT_VERB: Record<string, string> = { CHECK_IN: 'arrived', SEEN: 'was seen', CHECK_OUT: 'was seen' };

export default function OverviewPage() {
  const { status, health, can } = useShell();
  const canManagePeople = can('people.manage');
  const [daily, setDaily] = useState<Daily | null>(null);
  const [week, setWeek] = useState<WeekPoint[] | null>(null);
  const [events, setEvents] = useState<RecognitionEvent[] | null>(null);
  const [cameras, setCameras] = useState<any[] | null>(null);
  const [enrolledIds, setEnrolledIds] = useState<Set<string> | null>(null);
  const [zoneCount, setZoneCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const loadLive = useCallback(async () => {
    const gap = readGap() ?? undefined; // undefined = the system setting
    const [d, e] = await Promise.allSettled([workHoursApi.daily(undefined, gap), api.getRecognitionEvents(12)]);
    if (d.status === 'fulfilled') {
      setDaily(d.value);
      setError(null);
      try {
        const s = await workHoursApi.summary(shiftDate(d.value.today, -6), d.value.today, gap);
        setWeek(
          s.dates.map((date) => {
            const days = s.data.map((r) => r.days.find((x) => x.date === date)!).filter(Boolean);
            return {
              date,
              insideMinutes: days.reduce((a, x) => a + (x.present ? x.insideMinutes : 0), 0),
              present: days.filter((x) => x.present).length,
              late: days.filter((x) => x.isLate).length,
            };
          })
        );
      } catch {
        /* chart keeps its last render */
      }
    } else {
      setError(d.reason?.message || 'Could not load today’s data');
    }
    if (e.status === 'fulfilled') setEvents(e.value.data.filter((x) => x.action !== 'IGNORED_INACTIVE'));
    setNow(Date.now());
  }, []);

  useEffect(() => {
    loadLive();
    api.getCameras().then((r) => setCameras(r.data.filter((c: any) => c.isEnabled !== false))).catch(() => setCameras([]));
    api.getFaceEnrollments().then((r) => setEnrolledIds(new Set(r.data.filter((x) => x.samples > 0).map((x) => x.employeeId)))).catch(() => {});
    api.getZones().then((r) => setZoneCount(r.count ?? r.data.length)).catch(() => {});
    const t = setInterval(loadLive, 30000);
    return () => clearInterval(t);
  }, [loadLive]);

  const isToday = !!daily?.isToday;
  const rows = useMemo(() => {
    if (!daily) return [];
    return [...daily.data]
      .map((r) => ({ r, p: presenceOf(r, isToday) }))
      .sort((a, b) => a.p.order - b.p.order || (a.r.firstSeen ?? '').localeCompare(b.r.firstSeen ?? '') || a.r.employee.fullName.localeCompare(b.r.employee.fullName));
  }, [daily, isToday]);

  const total = daily?.summary.employees ?? 0;
  const inNow = rows.filter((x) => x.p.tone === 'in').length;
  const notSeen = rows.filter((x) => x.p.tone === 'away').length;
  const notIn = rows.filter((x) => x.p.tone === 'out').length;
  const arrived = daily?.summary.present ?? 0;
  const late = rows.filter((x) => x.r.isLate).length;
  const awayPeriods = rows.flatMap((x) => x.r.awayPeriods);
  const longestAway = Math.max(0, ...awayPeriods.map((p) => p.seconds));

  const windowRange = useMemo(() => {
    const withData = rows.filter((x) => x.r.sessions.length);
    if (!withData.length) return null;
    const hour = 3600_000;
    const start = Math.floor(Math.min(...withData.map((x) => new Date(x.r.sessions[0].start).getTime())) / hour) * hour;
    let end = Math.max(...withData.map((x) => new Date(x.r.sessions[x.r.sessions.length - 1].end).getTime()));
    if (isToday) end = Math.max(end, now);
    return { start, end: Math.max(start + hour, Math.ceil(end / hour) * hour) };
  }, [rows, isToday, now]);

  const activeIds = new Set(daily?.data.map((r) => r.employee.id) ?? []);
  const enrolled = enrolledIds ? Array.from(enrolledIds).filter((id) => activeIds.has(id)).length : null;
  const setup = [
    ...(cameras && cameras.length === 0
      ? [
          {
            done: false,
            title: 'Add your camera',
            detail: 'Add an IP, USB or EZVIZ camera in Settings',
            href: '/dashboard/settings?tab=cameras',
          },
        ]
      : []),
    {
      done: health === 'live',
      title: health === 'live' ? 'Face recognition is running' : 'Start face recognition',
      detail: health === 'live' ? 'Cameras are being watched' : 'Run start-all.ps1 on the office PC',
      href: '/dashboard/cameras',
    },
    {
      done: total > 0 && enrolled !== null && enrolled >= total,
      title: enrolled !== null && enrolled >= total && total > 0 ? 'Every employee is enrolled' : `Enrol ${Math.max(0, total - (enrolled ?? 0))} more face${total - (enrolled ?? 0) === 1 ? '' : 's'}`,
      detail: `${enrolled ?? '—'} of ${total} employees can be recognised`,
      href: '/dashboard/employees',
    },
    {
      done: (zoneCount ?? 0) > 0,
      title: (zoneCount ?? 0) > 0 ? 'Rooms are set up' : 'Draw rooms and the door line',
      detail: (zoneCount ?? 0) > 0 ? `${zoneCount} zones configured` : 'Adds time per room and exits through the door',
      href: '/dashboard/zones',
    },
  ];
  const setupDone = setup.filter((s) => s.done).length;
  // Setup steps are only useful to the people who can do them.
  const showSetup = (can('setup.manage') || canManagePeople) && zoneCount !== null && enrolled !== null && status !== null && setupDone < setup.length;

  const channelState = (cameraId: string, channelNo: number) => status?.channels?.find((c) => c.cameraId === cameraId && c.channelNo === channelNo);

  return (
    <>
      <Header
        title="Overview"
        subtitle={daily ? `${fmtDate(daily.date, { weekday: 'long', day: 'numeric', month: 'long' })} · updated ${timeAgo(new Date(now).toISOString(), Date.now())}` : 'Loading…'}
        actions={
          <>
            <Link href="/dashboard/office-time" className={btn.secondary}>
              <Clock className="w-4 h-4" /> Office Time
            </Link>
            {canManagePeople && (
              <Link href="/dashboard/employees/register" className={btn.primary}>
                <UserPlus className="w-4 h-4" /> Add employee
              </Link>
            )}
          </>
        }
      />

      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] w-full mx-auto">
        {health === 'offline' && (
          <div className="flex items-start gap-3 rounded-xl bg-rose-50 ring-1 ring-inset ring-rose-200 px-4 py-3 text-[13px] text-rose-900">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-rose-600" />
            <p>
              <b className="font-semibold">Face recognition is offline.</b> The cameras aren&apos;t being watched, so arrivals and office time
              aren&apos;t being recorded.{' '}
              {can('setup.manage') ? (
                <>
                  Start it with <code className="px-1 py-0.5 rounded bg-rose-100 text-[12px]">start-all.ps1</code>.
                </>
              ) : (
                'Let your admin know.'
              )}
            </p>
          </div>
        )}
        {error && (
          <div className="flex items-center gap-3 rounded-xl bg-amber-50 ring-1 ring-inset ring-amber-200 px-4 py-3 text-[13px] text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" /> {error}
          </div>
        )}

        {/* KPIs */}
        <div className="grid gap-3 sm:gap-4 grid-cols-2 xl:grid-cols-4">
          <Card className="p-5 col-span-2 xl:col-span-1">
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-medium text-slate-500">In the office now</p>
              <UserCheck className="w-4 h-4 text-slate-400" />
            </div>
            {daily ? (
              <>
                <p className="mt-2 flex items-baseline gap-2">
                  <span className="text-[48px] leading-none font-semibold tracking-tight text-slate-900">{isToday ? inNow : '—'}</span>
                  <span className="text-[13px] text-slate-500">of {total}</span>
                </p>
                <div className="mt-4 flex h-2 gap-[2px] rounded-full overflow-hidden bg-slate-100" role="img" aria-label={`${inNow} in office, ${notSeen} not seen now, ${notIn} not in yet`}>
                  {[
                    { v: inNow, c: STATUS.in },
                    { v: notSeen, c: STATUS.away },
                    { v: notIn, c: STATUS.out },
                  ]
                    .filter((p) => p.v > 0)
                    .map((p, i) => (
                      <span key={i} style={{ flexGrow: p.v, background: p.c }} />
                    ))}
                </div>
                <ul className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-slate-500">
                  {[
                    { label: 'In', v: inNow, c: STATUS.in },
                    { label: 'Not seen now', v: notSeen, c: STATUS.away },
                    { label: 'Not in', v: notIn, c: STATUS.out },
                  ].map((l) => (
                    <li key={l.label} className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm" style={{ background: l.c }} />
                      {l.label} <span className="font-medium text-slate-700 tabular-nums">{l.v}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Skeleton className="mt-3 h-20" />
            )}
          </Card>

          <StatTile
            label="Arrived today"
            icon={Footprints}
            value={daily ? arrived : <Skeleton className="h-7 w-12" />}
            sub={daily ? (late ? <span>of {total} · <span className="text-rose-600 font-medium">{late} late</span></span> : `of ${total} · no late arrivals`) : undefined}
          />
          <StatTile
            label="Average time inside"
            icon={Timer}
            value={daily ? (arrived ? fmtMin(daily.summary.avgInsideMinutes) : '—') : <Skeleton className="h-7 w-20" />}
            sub={daily ? (arrived ? `${fmtMin(daily.summary.totalInsideMinutes)} in total today` : 'No one has come in yet') : undefined}
          />
          <StatTile
            className="col-span-2 xl:col-span-1"
            label="Times stepped out"
            icon={DoorOpen}
            value={daily ? awayPeriods.length : <Skeleton className="h-7 w-10" />}
            sub={daily ? (awayPeriods.length ? `Longest ${fmtDur(longestAway)} · away after ${daily.settings.presenceGapMin} min unseen` : 'No one has stepped out') : undefined}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {/* Who's in */}
          <Card className="lg:col-span-2 overflow-hidden">
            <CardHeader
              title="Today"
              description={daily ? `Everyone, ordered by who is in` : undefined}
              action={<CardLink href="/dashboard/office-time">Office Time →</CardLink>}
            />
            {!daily ? (
              <div className="px-5 pb-5 space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No employees yet"
                description="Add your team, then let them enrol their face from their phone."
                action={
                  canManagePeople ? (
                    <Link href="/dashboard/employees/register" className={btn.primary}>
                      <UserPlus className="w-4 h-4" /> Add employee
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <div>
                <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_7.5rem_6rem_6rem_minmax(0,1.2fr)] gap-4 px-5 py-2 border-y border-slate-100 bg-slate-50/60 text-[11.5px] font-medium text-slate-500">
                  <span>Employee</span>
                  <span>Status</span>
                  <span>Arrived</span>
                  <span className="text-right">Inside</span>
                  <span>
                    Day{windowRange ? ` · ${fmtTime(new Date(windowRange.start).toISOString())} – ${fmtTime(new Date(windowRange.end).toISOString())}` : ''}
                  </span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {rows.slice(0, 8).map(({ r, p }) => (
                    <li key={r.employee.id}>
                      <Link
                        href="/dashboard/office-time"
                        className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1.6fr)_7.5rem_6rem_6rem_minmax(0,1.2fr)] items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-slate-50/70 transition-colors"
                      >
                        <span className="flex items-center gap-3 min-w-0">
                          <Avatar name={r.employee.fullName} id={r.employee.id} />
                          <span className="min-w-0">
                            <span className="block text-[13.5px] font-medium text-slate-900 truncate">{r.employee.fullName}</span>
                            <span className="block text-[12px] text-slate-500 truncate">
                              {r.employee.jobTitle || r.employee.department || r.employee.employeeCode}
                            </span>
                          </span>
                        </span>
                        <span className="justify-self-end md:justify-self-start">
                          <PresenceBadge tone={p.tone}>{p.label}</PresenceBadge>
                        </span>
                        <span className="hidden md:flex items-center gap-1.5 text-[13px] text-slate-700 tabular-nums">
                          {fmtTime(r.firstSeen ?? r.checkIn)}
                          {r.isLate && <Tag tone="rose">Late</Tag>}
                        </span>
                        <span className="hidden md:block text-right text-[13px] font-medium text-slate-900 tabular-nums">{r.date ? fmtDur(r.insideSeconds) : '—'}</span>
                        <span className="hidden md:block">{windowRange && <DayStrip row={r} start={windowRange.start} end={windowRange.end} />}</span>
                        <span className="md:hidden col-span-2 text-[12px] text-slate-500 pl-12 tabular-nums">
                          {r.date ? `Arrived ${fmtTime(r.firstSeen ?? r.checkIn)} · inside ${fmtDur(r.insideSeconds)}` : 'Not seen today'}
                          {r.isLate ? ' · late' : ''}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {rows.length > 8 && (
                  <Link href="/dashboard/office-time" className="flex items-center justify-center gap-1 py-3 border-t border-slate-100 text-[12.5px] font-medium text-slate-600 hover:text-slate-900">
                    Show all {rows.length} <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                )}
              </div>
            )}
          </Card>

          <div className="space-y-4">
            {/* Cameras */}
            <Card>
              <CardHeader title="Cameras" action={can('cameras.live') ? <CardLink href="/dashboard/cameras">Live view →</CardLink> : undefined} />
              <ul className="px-2 pb-3">
                {!cameras ? (
                  <li className="px-3 py-2">
                    <Skeleton className="h-9" />
                  </li>
                ) : cameras.length === 0 ? (
                  <li className="px-3 py-2 text-[13px] text-slate-500">
                    No cameras yet.{' '}
                    <Link href="/dashboard/settings?tab=cameras" className="font-medium text-blue-600 hover:text-blue-700">
                      Add one in Settings
                    </Link>
                  </li>
                ) : (
                  cameras.flatMap((cam) =>
                    (cam.channels?.length ? cam.channels : [{ channelNo: 1, channelName: cam.name }]).map((ch: any) => {
                      const st = channelState(cam.id, ch.channelNo);
                      const live = health !== 'offline' && st?.state === 'running';
                      const label =
                        ch.recognitionEnabled === false
                          ? 'Recognition off'
                          : health === 'offline' || !st
                          ? 'Not watched'
                          : st.state === 'running'
                          ? 'Live'
                          : st.state === 'error'
                          ? 'Error'
                          : 'Connecting';
                      const dot = live ? 'bg-emerald-500' : st?.state === 'error' ? 'bg-rose-500' : health === 'offline' || !st ? 'bg-slate-300' : 'bg-amber-500';
                      return (
                        <li key={`${cam.id}-${ch.channelNo}`} className="flex items-center gap-3 px-3 py-2 rounded-lg">
                          <span className="w-9 h-9 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                            <Cctv className="w-[18px] h-[18px]" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium text-slate-800 truncate">{ch.channelName || `Channel ${ch.channelNo}`}</span>
                            <span className="block text-[12px] text-slate-500 truncate">
                              {st?.lastFrameAt && health !== 'offline' ? `Last frame ${timeAgo(st.lastFrameAt, now)}` : cam.name}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 text-[12px] font-medium text-slate-600">
                            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} /> {label}
                          </span>
                        </li>
                      );
                    })
                  )
                )}
              </ul>
            </Card>

            {/* Activity */}
            <Card>
              <CardHeader title="Recent sightings" description="Latest faces recognised by the cameras" />
              {!events ? (
                <div className="px-5 pb-5 space-y-3">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : events.length === 0 ? (
                <EmptyState icon={ScanFace} title="No sightings yet" description="Recognised faces will appear here as people pass the cameras." />
              ) : (
                <ul className="px-2 pb-3">
                  {events.slice(0, 6).map((e) => (
                    <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                      <Avatar size="sm" name={e.employee?.fullName ?? '?'} id={e.employeeId} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-slate-800 truncate">
                          <span className="font-medium">{e.employee?.fullName ?? 'Someone'}</span>{' '}
                          <span className="text-slate-500">{EVENT_VERB[e.action] ?? 'was seen'}</span>
                        </span>
                        <span className="block text-[11.5px] text-slate-400">Channel {e.channelNo}</span>
                      </span>
                      <span className="text-[12px] text-slate-500 tabular-nums whitespace-nowrap">{timeAgo(e.seenAt, now)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className={showSetup ? 'lg:col-span-2' : 'lg:col-span-3'}>
            {week && daily ? (
              <WeekChart title="Time in the office this week" description="Total for everyone, per day" data={week} today={daily.today} />
            ) : (
              <>
                <CardHeader title="Time in the office this week" description="Total for everyone, per day" />
                <Skeleton className="mx-5 mb-5 h-56" />
              </>
            )}
          </Card>

          {showSetup && (
            <Card>
              <CardHeader title="Setup" description={`${setupDone} of ${setup.length} done`} />
              <ul className="px-2 pb-3">
                {setup.map((s) => (
                  <li key={s.href}>
                    <Link href={s.href} className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 transition-colors">
                      {s.done ? <CheckCircle2 className="w-[18px] h-[18px] mt-px text-emerald-600 shrink-0" /> : <Circle className="w-[18px] h-[18px] mt-px text-slate-300 shrink-0" />}
                      <span className="min-w-0">
                        <span className={`block text-[13px] font-medium ${s.done ? 'text-slate-500' : 'text-slate-900'}`}>{s.title}</span>
                        <span className="block text-[12px] text-slate-500">{s.detail}</span>
                      </span>
                      {!s.done && <ArrowRight className="w-4 h-4 mt-0.5 ml-auto text-slate-400 shrink-0" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </main>
    </>
  );
}
