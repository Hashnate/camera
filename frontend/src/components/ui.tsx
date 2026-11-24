'use client';

/** Small shared building blocks for the dashboard. Status colours always come with a text label. */

import React from 'react';
import Link from 'next/link';
import type { SystemHealth } from '@/components/shell/ShellContext';
import { initials } from '@/lib/format';

// ---------------------------------------------------------------- buttons

export const btn = {
  primary:
    'inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-slate-900 text-white text-[13px] font-medium shadow-sm hover:bg-slate-800 active:bg-slate-950 transition-colors disabled:opacity-50',
  secondary:
    'inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-white text-slate-700 text-[13px] font-medium ring-1 ring-inset ring-slate-200 shadow-sm hover:bg-slate-50 transition-colors disabled:opacity-50',
  ghost: 'inline-flex items-center gap-1 text-[13px] font-medium text-slate-600 hover:text-slate-900 transition-colors',
};

// ---------------------------------------------------------------- cards

export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <section className={`bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${className}`}>{children}</section>;
}

export function CardHeader({
  title,
  description,
  action,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 px-4 sm:px-5 pt-4 pb-3 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold text-slate-900">{title}</h2>
        {description && <p className="text-[12.5px] text-slate-500 mt-0.5">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-[12.5px] font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap">
      {children}
    </Link>
  );
}

/** Stat tile: label (sentence case), value, optional sub-line. */
export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <Card className={`p-4 sm:p-5 min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12.5px] sm:text-[13px] font-medium text-slate-500">{label}</p>
        {Icon && <Icon className="w-4 h-4 text-slate-400 shrink-0" />}
      </div>
      <p className="mt-2 text-[24px] sm:text-[28px] leading-none font-semibold tracking-tight text-slate-900">{value}</p>
      {sub && <p className="mt-2 text-[12.5px] text-slate-500">{sub}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- status

export function healthLabel(h: SystemHealth) {
  return h === 'live' ? 'Recognition live' : h === 'offline' ? 'Recognition offline' : h === 'degraded' ? 'Camera connecting' : 'Checking…';
}

export function HealthDot({ health }: { health: SystemHealth }) {
  const color = health === 'live' ? 'bg-emerald-500' : health === 'offline' ? 'bg-rose-500' : health === 'degraded' ? 'bg-amber-500' : 'bg-slate-300';
  return (
    <span className="relative flex w-2 h-2 shrink-0" aria-hidden="true">
      {health === 'live' && <span className="absolute inset-0 rounded-full bg-emerald-400 opacity-70 animate-ping" />}
      <span className={`relative w-2 h-2 rounded-full ${color}`} />
    </span>
  );
}

export type PresenceTone = 'in' | 'away' | 'out' | 'present';

const PRESENCE: Record<PresenceTone, { dot: string; chip: string }> = {
  in: { dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15' },
  away: { dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-800 ring-amber-600/20' },
  out: { dot: 'bg-slate-300', chip: 'bg-slate-50 text-slate-500 ring-slate-500/15' },
  present: { dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-700 ring-blue-600/15' },
};

export function PresenceBadge({ tone, children }: { tone: PresenceTone; children: React.ReactNode }) {
  const p = PRESENCE[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11.5px] font-medium ring-1 ring-inset whitespace-nowrap ${p.chip}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${p.dot}`} />
      {children}
    </span>
  );
}

export function Tag({ tone = 'slate', children }: { tone?: 'slate' | 'rose' | 'amber' | 'blue' | 'emerald'; children: React.ReactNode }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    rose: 'bg-rose-50 text-rose-700',
    amber: 'bg-amber-50 text-amber-800',
    blue: 'bg-blue-50 text-blue-700',
    emerald: 'bg-emerald-50 text-emerald-700',
  };
  return <span className={`inline-flex items-center h-5 px-1.5 rounded-md text-[10.5px] font-semibold uppercase tracking-wide ${tones[tone]}`}>{children}</span>;
}

// ---------------------------------------------------------------- people

const AVATAR_TONES = [
  'bg-blue-100 text-blue-700',
  'bg-violet-100 text-violet-700',
  'bg-teal-100 text-teal-700',
  'bg-orange-100 text-orange-700',
  'bg-pink-100 text-pink-700',
  'bg-sky-100 text-sky-700',
];

export function Avatar({ name, id, size = 'md' }: { name: string; id?: string; size?: 'sm' | 'md' }) {
  const key = id || name;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const dims = size === 'sm' ? 'w-7 h-7 text-[10.5px]' : 'w-9 h-9 text-[12px]';
  return (
    <span className={`${dims} rounded-full font-semibold flex items-center justify-center shrink-0 ${AVATAR_TONES[h % AVATAR_TONES.length]}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------- empty / loading

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10">
      <span className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">
        <Icon className="w-5 h-5" />
      </span>
      <p className="mt-3 text-[13.5px] font-medium text-slate-800">{title}</p>
      {description && <p className="mt-1 text-[12.5px] text-slate-500 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-100 ${className}`} />;
}
