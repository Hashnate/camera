'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { KeyRound, LogOut, ScanFace, X } from 'lucide-react';
import { api, setStoredToken } from '@/lib/api';
import { NAV_GROUPS, isActive } from '@/lib/nav';
import { initials } from '@/lib/format';
import { useShell } from '@/components/shell/ShellContext';
import { HealthDot, healthLabel } from '@/components/ui';

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-2">
      <span className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shadow-sm shadow-blue-600/30">
        <ScanFace className="w-[18px] h-[18px]" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-slate-900">WorkSight</span>
    </Link>
  );
}

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, status, health, can } = useShell();

  const signOut = async () => {
    await api.logout().catch(() => {}); // clears the sign-in cookie too
    setStoredToken(null);
    router.push('/login');
  };

  // Only the pages this person can open.
  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => can(i.perm) && (!i.needsEmployee || !!user?.employee)),
  })).filter((g) => g.items.length > 0);

  const channels = status?.channels ?? [];
  const live = channels.filter((c) => c.state === 'running').length;

  return (
    <div className="flex flex-col h-full">
      <div className="h-16 flex items-center px-4 shrink-0">
        <Brand />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-5" aria-label="Main">
        {groups.map((group) => (
          <div key={group.label ?? 'main'}>
            {group.label && <p className="px-2.5 mb-1.5 text-[11px] font-medium text-slate-400">{group.label}</p>}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item, pathname);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13.5px] transition-colors ${
                        active ? 'bg-slate-100 text-slate-900 font-semibold' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                      }`}
                    >
                      <Icon className={`w-[18px] h-[18px] shrink-0 ${active ? 'text-blue-600' : 'text-slate-400 group-hover:text-slate-500'}`} />
                      {item.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-slate-200/80 space-y-2 shrink-0">
        {can('reports.view') && (
        <Link
          href={can('cameras.live') ? '/dashboard/cameras' : '/dashboard'}
          onClick={onNavigate}
          className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-50 transition-colors"
        >
          <HealthDot health={health} />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-slate-700">{healthLabel(health)}</span>
            <span className="block text-[11px] text-slate-400 truncate">
              {health === 'offline'
                ? 'Attendance is not being recorded'
                : health === 'checking'
                ? 'Checking cameras…'
                : `${live} of ${channels.length} camera channel${channels.length === 1 ? '' : 's'} live`}
            </span>
          </span>
        </Link>
        )}

        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <span className="w-8 h-8 rounded-full bg-slate-900 text-white text-[11px] font-semibold flex items-center justify-center shrink-0">
            {initials(user?.fullName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] font-medium text-slate-800 truncate">{user?.fullName ?? '—'}</span>
            <span className="block text-[11px] text-slate-400 truncate">{user?.roleLabel ?? ''}</span>
          </span>
          <Link
            href="/change-password"
            onClick={onNavigate}
            title="Change password"
            aria-label="Change password"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <KeyRound className="w-4 h-4" />
          </Link>
          <button
            type="button"
            onClick={signOut}
            title="Sign out"
            aria-label="Sign out"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const { mobileNavOpen, setMobileNavOpen } = useShell();
  const pathname = usePathname();

  // Close the mobile drawer on navigation and on Escape.
  useEffect(() => setMobileNavOpen(false), [pathname, setMobileNavOpen]);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen, setMobileNavOpen]);

  return (
    <>
      <aside className="hidden lg:block w-60 shrink-0 bg-white border-r border-slate-200/80 sticky top-0 h-screen">
        <NavContent />
      </aside>

      {mobileNavOpen && (
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => setMobileNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="absolute right-3 top-4 p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
            <NavContent onNavigate={() => setMobileNavOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
