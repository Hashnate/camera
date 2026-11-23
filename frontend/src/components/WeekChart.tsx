'use client';

/**
 * "Time in office this week": one series (total inside hours per day, all employees), so no
 * legend box; the card title names it. Columns <= 24px with 4px rounded tops, hairline solid
 * grid, value-first hover tooltip, a direct label on the latest day only, and a table view.
 */

import React, { useState } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtDate, fmtMin } from '@/lib/format';
import { CardHeader } from '@/components/ui';

export interface WeekPoint {
  date: string;
  insideMinutes: number;
  present: number;
  late: number;
}

const SERIES = '#2a78d6'; // validated categorical slot 1 (light surface)
const SERIES_HOVER = '#3987e5';
const GRID = '#e1e0d9';
const AXIS = '#c3c2b7';
const MUTED = '#898781';
const SECONDARY = '#52514e';

function TooltipBody({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p: WeekPoint & { hours: number } = payload[0].payload;
  return (
    <div className="rounded-lg bg-white px-3 py-2 shadow-lg ring-1 ring-slate-200 text-[12px]">
      <p className="text-[15px] font-semibold text-slate-900">{fmtMin(p.insideMinutes)}</p>
      <p className="text-slate-500">{fmtDate(p.date, { weekday: 'long', day: 'numeric', month: 'short' })}</p>
      <p className="mt-1 flex items-center gap-1.5 text-slate-600">
        <span className="w-3 h-0.5 rounded-full" style={{ background: SERIES }} />
        {p.present} {p.present === 1 ? 'person' : 'people'} in{p.late ? ` · ${p.late} late` : ''}
      </p>
    </div>
  );
}

export function WeekChart({ data, today, title, description }: { data: WeekPoint[]; today: string; title: string; description?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const rows = data.map((d) => ({ ...d, hours: Math.round((d.insideMinutes / 60) * 10) / 10 }));
  const max = Math.max(1, ...rows.map((r) => r.hours));
  const top = max <= 4 ? Math.ceil(max) : Math.ceil(max / 2) * 2;
  const lastIndex = rows.length - 1;

  return (
    <div>
      <CardHeader
        title={title}
        description={description}
        action={
          <div className="inline-flex p-0.5 rounded-lg bg-slate-100 text-[11.5px] font-medium" role="tablist" aria-label="Chart or table">
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`px-2.5 py-1 rounded-md capitalize transition ${view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {v}
              </button>
            ))}
          </div>
        }
      />

      {view === 'chart' ? (
        <div className="h-56 px-2 pb-3" aria-label="Total time inside the office per day, last 7 days">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 22, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => (d === today ? 'Today' : fmtDate(d, { weekday: 'short' }))}
                tickLine={false}
                axisLine={{ stroke: AXIS }}
                tick={{ fill: MUTED, fontSize: 12 }}
                dy={6}
              />
              <YAxis
                domain={[0, top]}
                allowDecimals={false}
                tickFormatter={(v: number) => `${v}h`}
                tickLine={false}
                axisLine={false}
                tick={{ fill: MUTED, fontSize: 12 }}
                width={40}
              />
              <Tooltip content={<TooltipBody />} cursor={{ fill: 'rgba(15,23,42,0.04)' }} />
              <Bar dataKey="hours" fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={24} activeBar={{ fill: SERIES_HOVER }} isAnimationActive={false}>
                <LabelList
                  dataKey="insideMinutes"
                  content={(props: any) => {
                    if (props.index !== lastIndex || !props.value) return null;
                    return (
                      <text x={props.x + props.width / 2} y={props.y - 7} textAnchor="middle" fill={SECONDARY} fontSize={12} fontWeight={600}>
                        {fmtMin(props.value)}
                      </text>
                    );
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="px-5 pb-4">
          <table className="w-full text-[12.5px]">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="text-left font-medium py-2">Day</th>
                <th className="text-right font-medium py-2">Time inside</th>
                <th className="text-right font-medium py-2">People in</th>
                <th className="text-right font-medium py-2">Late</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((r) => (
                <tr key={r.date} className="border-b border-slate-50 last:border-0">
                  <td className="py-2 text-slate-700">{r.date === today ? 'Today' : fmtDate(r.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                  <td className="py-2 text-right font-medium text-slate-900">{r.insideMinutes ? fmtMin(r.insideMinutes) : '—'}</td>
                  <td className="py-2 text-right text-slate-600">{r.present}</td>
                  <td className="py-2 text-right text-slate-600">{r.late}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
