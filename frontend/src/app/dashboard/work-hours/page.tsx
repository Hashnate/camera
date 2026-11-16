'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Timer, Users, Building2, LogOut, UserX, Download, Info } from 'lucide-react';
import { Header } from '@/components/Header';
import { workHoursApi, WorkDayRow, WorkPeriodRow } from '@/lib/api';

// ---------------------------------------------------------------- helpers

const INSIDE = '#2563eb'; // blue-600: the one series colour on this page
const TRACK = '#f1f5f9'; // slate-100

const fmt = (min: number) => (min > 0 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '—');
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutesOfDay = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

type Tip = { x: number; y: number; lines: string[] } | null;

function useTooltip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = (e: React.MouseEvent, lines: string[]) => setTip({ x: e.clientX, y: e.clientY, lines });
  const hide = () => setTip(null);
  const node = tip && (
    <div
      className="fixed z-50 pointer-events-none px-2.5 py-1.5 rounded-md bg-slate-900 text-white text-[11px] shadow-lg"
      style={{ left: tip.x + 12, top: tip.y + 12 }}
    >
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? 'font-semibold' : 'text-slate-300'}>
          {l}
        </div>
      ))}
    </div>
  );
  return { show, hide, node };
}

function StateBadge({ state }: { state: WorkDayRow['state'] }) {
  if (state === 'IN_OFFICE')
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> In office
      </span>
    );
  if (state === 'LEFT')
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-600 border border-slate-200">
        <LogOut className="w-3 h-3" /> Left
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold text-slate-400 border border-slate-200">
      <UserX className="w-3 h-3" /> Absent
    </span>
  );
}

function Meter({ value, max }: { value: number; max: number | null }) {
  if (!max) return null;
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="mt-1 flex items-center gap-2" title={`${pct}% of the ${fmt(max)} schedule`}>
      <div className="h-1.5 w-24 rounded-full overflow-hidden" style={{ background: TRACK }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: INSIDE }} />
      </div>
      <span className="text-[10px] text-slate-400">{pct}% of {fmt(max)}</span>
    </div>
  );
}

function Kpi({ label, value, icon: Icon }: { label: string; value: React.ReactNode; icon: React.ElementType }) {
  return (
    <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
      <div>
        <p className="text-[11px] font-semibold text-slate-500 uppercase">{label}</p>
        <h4 className="text-xl font-bold text-slate-900 mt-0.5">{value}</h4>
      </div>
      <div className="w-9 h-9 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center">
        <Icon className="w-5 h-5" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- daily view

function Timeline({
  row,
  window,
  nowMin,
  tooltip,
}: {
  row: WorkDayRow;
  window: [number, number];
  nowMin: number | null;
  tooltip: ReturnType<typeof useTooltip>;
}) {
  const [lo, hi] = window;
  const pos = (m: number) => `${((Math.min(Math.max(m, lo), hi) - lo) / (hi - lo)) * 100}%`;
  const width = (a: number, b: number) => `${Math.max(0.6, ((Math.min(b, hi) - Math.max(a, lo)) / (hi - lo)) * 100)}%`;

  const manual = !row.measured && row.checkIn && row.lastSeen;
  return (
    <div className="relative h-5 rounded" style={{ background: TRACK }}>
      {row.sessions.map((s, i) => (
        <div
          key={i}
          className="absolute top-0.5 bottom-0.5 rounded-[3px] cursor-default"
          style={{ left: pos(minutesOfDay(s.start)), width: width(minutesOfDay(s.start), minutesOfDay(s.end)), background: INSIDE }}
          onMouseMove={(e) => tooltip.show(e, [`Inside ${fmt(s.minutes)}`, `${time(s.start)} – ${time(s.end)}`])}
          onMouseLeave={tooltip.hide}
        />
      ))}
      {manual && (
        <div
          className="absolute top-0.5 bottom-0.5 rounded-[3px] border border-slate-300"
          style={{
            left: pos(minutesOfDay(row.checkIn!)),
            width: width(minutesOfDay(row.checkIn!), minutesOfDay(row.lastSeen!)),
            background: 'repeating-linear-gradient(135deg, #cbd5e1 0 3px, transparent 3px 7px)',
          }}
          onMouseMove={(e) =>
            tooltip.show(e, [`Manual entry ${fmt(row.spanMinutes)}`, `${time(row.checkIn)} – ${time(row.lastSeen)}`, 'Not measured by camera'])
          }
          onMouseLeave={tooltip.hide}
        />
      )}
      {nowMin !== null && nowMin > lo && nowMin < hi && (
        <div className="absolute -top-0.5 -bottom-0.5 w-px bg-slate-400" style={{ left: pos(nowMin) }} />
      )}
    </div>
  );
}

function DailyView() {
  const [date, setDate] = useState(localDate());
  const [res, setRes] = useState<Awaited<ReturnType<typeof workHoursApi.daily>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooltip = useTooltip();

  const load = useCallback(async () => {
    try {
      setRes(await workHoursApi.daily(date));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [date]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000); // live-ish: hours grow as people are seen
    return () => clearInterval(t);
  }, [load]);

  const rows = useMemo(
    () =>
      [...(res?.data ?? [])].sort(
        (a, b) => ['IN_OFFICE', 'LEFT', 'ABSENT'].indexOf(a.state) - ['IN_OFFICE', 'LEFT', 'ABSENT'].indexOf(b.state) || b.insideMinutes - a.insideMinutes
      ),
    [res]
  );

  // Shared time axis: at least 07:00–19:00, widened to fit everyone's day.
  const window = useMemo<[number, number]>(() => {
    let lo = 7 * 60, hi = 19 * 60;
    rows.forEach((r) => {
      if (r.checkIn) lo = Math.min(lo, minutesOfDay(r.checkIn));
      if (r.lastSeen) hi = Math.max(hi, minutesOfDay(r.lastSeen) + 1);
    });
    return [Math.floor(lo / 60) * 60, Math.ceil(hi / 60) * 60];
  }, [rows]);
  const ticks = [];
  for (let m = window[0]; m <= window[1]; m += 120) ticks.push(m);
  const nowMin = res?.isToday ? minutesOfDay(new Date().toISOString()) : null;

  const s = res?.summary;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="In office now" value={res?.isToday ? s?.inOfficeNow ?? '—' : '—'} icon={Building2} />
        <Kpi label="Present" value={s ? `${s.present} / ${s.employees}` : '—'} icon={Users} />
        <Kpi label="Avg time inside" value={s ? fmt(s.avgInsideMinutes) : '—'} icon={Timer} />
        <Kpi label="Total time inside" value={s ? fmt(s.totalInsideMinutes) : '—'} icon={Timer} />
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-bold text-slate-900">Time inside the office</h3>
            <input
              type="date"
              value={date}
              max={localDate()}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-700"
            />
          </div>
          <div className="flex items-center gap-4 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2.5 rounded-sm" style={{ background: INSIDE }} /> Inside (camera)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-3 h-2.5 rounded-sm border border-slate-300"
                style={{ background: 'repeating-linear-gradient(135deg, #cbd5e1 0 2px, transparent 2px 4px)' }}
              />
              Manual entry (not measured)
            </span>
            {res?.isToday && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-px h-3 bg-slate-400" /> Now
              </span>
            )}
          </div>
        </div>

        {error && <p className="px-6 py-3 text-xs text-rose-600">{error}</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[900px]">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Employee</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">First in</th>
                <th className="py-3 px-4">Last seen</th>
                <th className="py-3 px-4">Time inside</th>
                <th className="py-3 px-4">Away</th>
                <th className="py-3 px-4 w-[34%]">
                  <div className="relative h-3">
                    {ticks.map((m) => (
                      <span
                        key={m}
                        className="absolute -translate-x-1/2 font-normal normal-case tracking-normal text-[10px] text-slate-400"
                        style={{ left: `${((m - window[0]) / (window[1] - window[0])) * 100}%` }}
                      >
                        {String(Math.floor(m / 60)).padStart(2, '0')}:00
                      </span>
                    ))}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {!res ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">Loading…</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.employee.id} className="hover:bg-slate-50/60">
                    <td className="py-3 px-4">
                      <p className="font-semibold text-slate-900">{r.employee.fullName}</p>
                      <p className="text-[11px] text-slate-400">{r.employee.department ?? r.employee.employeeCode}</p>
                    </td>
                    <td className="py-3 px-4"><StateBadge state={r.state} /></td>
                    <td className="py-3 px-4 font-mono">
                      {time(r.checkIn)}
                      {r.isLate && <span className="ml-1 text-[10px] text-amber-700 font-sans font-semibold">late</span>}
                    </td>
                    <td className="py-3 px-4 font-mono">{time(r.lastSeen)}</td>
                    <td className="py-3 px-4">
                      <span className="font-semibold text-slate-900">{fmt(r.insideMinutes)}</span>
                      {r.date && !r.measured && <span className="ml-1 text-[10px] text-slate-400">manual</span>}
                      {r.date && <Meter value={r.insideMinutes} max={r.scheduledMinutes} />}
                    </td>
                    <td className="py-3 px-4 text-slate-500">{r.measured ? fmt(r.awayMinutes) : '—'}</td>
                    <td className="py-3 px-4">
                      <Timeline row={r} window={window} nowMin={nowMin} tooltip={tooltip} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {res && (
          <p className="px-6 py-3 border-t border-slate-100 text-[11px] text-slate-400 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            Time inside adds up the periods the camera saw each person. A gap of more than {res.settings.presenceGapMin} minutes
            without a sighting counts as away. Point a camera lens at the work area, not only the door, so people are seen while
            at their desks.
          </p>
        )}
      </div>
      {tooltip.node}
    </div>
  );
}

// ---------------------------------------------------------------- period view

const PRESETS: { key: string; label: string; range: () => [Date, Date] }[] = [
  {
    key: 'week',
    label: 'This week',
    range: () => {
      const now = new Date();
      const start = new Date(now);
      start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday
      return [start, now];
    },
  },
  { key: '7d', label: 'Last 7 days', range: () => { const n = new Date(); const s = new Date(n); s.setDate(n.getDate() - 6); return [s, n]; } },
  { key: 'month', label: 'This month', range: () => { const n = new Date(); return [new Date(n.getFullYear(), n.getMonth(), 1), n]; } },
  {
    key: 'lastmonth',
    label: 'Last month',
    range: () => { const n = new Date(); return [new Date(n.getFullYear(), n.getMonth() - 1, 1), new Date(n.getFullYear(), n.getMonth(), 0)]; },
  },
];

function PeriodView() {
  const [preset, setPreset] = useState('week');
  const [range, setRange] = useState<[string, string]>(() => PRESETS[0].range().map(localDate) as [string, string]);
  const [res, setRes] = useState<Awaited<ReturnType<typeof workHoursApi.summary>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooltip = useTooltip();

  useEffect(() => {
    setRes(null);
    workHoursApi
      .summary(range[0], range[1])
      .then((r) => { setRes(r); setError(null); })
      .catch((e) => setError(e.message));
  }, [range]);

  const pick = (key: string) => {
    setPreset(key);
    setRange(PRESETS.find((p) => p.key === key)!.range().map(localDate) as [string, string]);
  };

  const rows = useMemo(() => [...(res?.data ?? [])].sort((a, b) => b.totalInsideMinutes - a.totalInsideMinutes), [res]);
  const dayMax = Math.max(60, ...rows.flatMap((r) => r.days.map((d) => d.insideMinutes)));

  const exportCsv = () => {
    if (!res) return;
    const header = ['Employee', 'Employee ID', 'Department', 'Days present', 'Late days', 'Total inside (h)', 'Avg inside per day (h)', 'First-in to last-seen (h)', ...res.dates];
    const lines = rows.map((r) => [
      r.employee.fullName,
      r.employee.employeeCode,
      r.employee.department ?? '',
      r.daysPresent,
      r.lateDays,
      (r.totalInsideMinutes / 60).toFixed(2),
      (r.avgInsideMinutes / 60).toFixed(2),
      (r.totalSpanMinutes / 60).toFixed(2),
      ...r.days.map((d) => (d.insideMinutes / 60).toFixed(2)),
    ]);
    const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `work-hours_${res.startDate}_to_${res.endDate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 p-1 bg-slate-100 rounded-lg text-xs font-semibold">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => pick(p.key)}
                className={`px-2.5 py-1 rounded-md ${preset === p.key ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={range[0]}
            onChange={(e) => { setPreset(''); e.target.value && setRange([e.target.value, range[1]]); }}
            className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs"
          />
          <span className="text-xs text-slate-400">to</span>
          <input
            type="date"
            value={range[1]}
            onChange={(e) => { setPreset(''); e.target.value && setRange([range[0], e.target.value]); }}
            className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs"
          />
        </div>
        <button
          onClick={exportCsv}
          disabled={!res}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {error && <p className="px-6 py-3 text-xs text-rose-600">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs min-w-[860px]">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
            <tr>
              <th className="py-3 px-4">Employee</th>
              <th className="py-3 px-4">Days present</th>
              <th className="py-3 px-4">Total inside</th>
              <th className="py-3 px-4">Avg per day</th>
              <th className="py-3 px-4">Late days</th>
              <th className="py-3 px-4">Time inside per day</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {!res ? (
              <tr><td colSpan={6} className="py-8 text-center text-slate-400">Loading…</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.employee.id} className="hover:bg-slate-50/60">
                  <td className="py-3 px-4">
                    <p className="font-semibold text-slate-900">{r.employee.fullName}</p>
                    <p className="text-[11px] text-slate-400">{r.employee.department ?? r.employee.employeeCode}</p>
                  </td>
                  <td className="py-3 px-4">{r.daysPresent}</td>
                  <td className="py-3 px-4 font-semibold text-slate-900">{fmt(r.totalInsideMinutes)}</td>
                  <td className="py-3 px-4">
                    {fmt(r.avgInsideMinutes)}
                    {r.daysPresent > 0 && <Meter value={r.avgInsideMinutes} max={r.scheduledMinutesPerDay} />}
                  </td>
                  <td className="py-3 px-4">{r.lateDays || '—'}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-end gap-[2px] h-8">
                      {r.days.map((d) => (
                        <div
                          key={d.date}
                          className="flex-1 min-w-[4px] max-w-[18px] h-full flex items-end cursor-default"
                          onMouseMove={(e) =>
                            tooltip.show(e, [
                              new Date(d.date + 'T00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
                              d.insideMinutes ? `Inside ${fmt(d.insideMinutes)}` : 'Not present',
                            ])
                          }
                          onMouseLeave={tooltip.hide}
                        >
                          <div
                            className="w-full rounded-t-[3px]"
                            style={{
                              height: d.insideMinutes ? `${Math.max(8, (d.insideMinutes / dayMax) * 100)}%` : '2px',
                              background: d.insideMinutes ? INSIDE : '#e2e8f0',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {tooltip.node}
    </div>
  );
}

// ---------------------------------------------------------------- page

export default function WorkHoursPage() {
  const [tab, setTab] = useState<'daily' | 'period'>('daily');
  return (
    <>
      <Header title="Work Hours" subtitle="How long each employee is actually inside the office, measured by the camera" />
      <main className="p-8 space-y-6">
        <div className="flex gap-1 p-1 bg-slate-100 rounded-lg text-xs font-semibold w-fit">
          {(
            [
              ['daily', 'Daily'],
              ['period', 'Weekly / monthly'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-md ${tab === k ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'daily' ? <DailyView /> : <PeriodView />}
      </main>
    </>
  );
}
