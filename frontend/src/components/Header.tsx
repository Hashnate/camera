'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { navItemFor } from '@/lib/nav';
import { useShell } from '@/components/shell/ShellContext';
import { HealthDot, healthLabel } from '@/components/ui';

interface HeaderProps {
  /** Defaults to the page's name in the navigation. */
  title?: string;
  /** Defaults to the page's description in the navigation. */
  subtitle?: string;
  /** Buttons shown on the right (e.g. "Add employee"). */
  actions?: React.ReactNode;
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  const pathname = usePathname();
  const { health, setMobileNavOpen, can } = useShell();
  const item = navItemFor(pathname);

  const healthTone =
    health === 'live'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/15'
      : health === 'offline'
      ? 'bg-rose-50 text-rose-700 ring-rose-600/15'
      : health === 'degraded'
      ? 'bg-amber-50 text-amber-800 ring-amber-600/20'
      : 'bg-slate-100 text-slate-600 ring-slate-500/10';

  return (
    <>
    <header className="sticky top-0 z-30 bg-[#f6f7f9]/85 backdrop-blur-md border-b border-slate-200/70">
      <div className="h-16 px-4 sm:px-6 lg:px-8 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          className="lg:hidden -ml-1 p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-200/60"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold tracking-tight text-slate-900 truncate">{title ?? item?.name ?? 'WorkSight'}</h1>
          <p className="hidden sm:block text-[12.5px] text-slate-500 truncate">{subtitle ?? item?.description ?? ''}</p>
        </div>

        {actions && <div className="hidden md:flex items-center gap-2">{actions}</div>}

        {can('reports.view') && (
          <Link
            href={can('cameras.live') ? '/dashboard/cameras' : '/dashboard'}
            title="Camera and face-recognition status"
            className={`inline-flex items-center gap-2 h-8 px-3 rounded-full text-xs font-medium ring-1 ring-inset transition-colors hover:brightness-[0.98] ${healthTone}`}
          >
            <HealthDot health={health} />
            <span className="hidden sm:inline">{healthLabel(health)}</span>
          </Link>
        )}
      </div>
    </header>
    {/* On phones the page actions get their own row under the bar instead of being hidden. */}
    {actions && <div className="md:hidden flex flex-wrap items-center gap-2 px-4 sm:px-6 pt-4 [&>*]:flex-1 [&>*]:min-w-[9rem]">{actions}</div>}
    </>
  );
}
