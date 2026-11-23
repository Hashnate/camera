'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Lock, RefreshCw } from 'lucide-react';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { ShellProvider, useShell } from '@/components/shell/ShellContext';
import { Card, EmptyState, btn } from '@/components/ui';
import { getStoredToken } from '@/lib/api';
import { homeFor, pagePermission } from '@/lib/nav';

function Spinner() {
  return (
    <div className="min-h-screen w-full bg-[#f6f7f9] flex items-center justify-center">
      <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" aria-label="Loading" />
    </div>
  );
}

/** Shows a page only to people allowed to open it. The server enforces the same rules on the data. */
function AccessGate({ children }: { children: React.ReactNode }) {
  const { user, userError, reloadUser, can } = useShell();
  const pathname = usePathname();
  const router = useRouter();
  const needed = pagePermission(pathname);
  const allowed = !needed || can(needed);
  const home = user ? homeFor(user.permissions, !!user.employee) : '/dashboard';

  useEffect(() => {
    if (!user) return;
    if (user.mustChangePassword) router.replace('/change-password');
    // The Overview is the default landing page; send people who can't see it to their own page.
    else if (!allowed && pathname === '/dashboard' && home !== '/dashboard') router.replace(home);
  }, [user, allowed, pathname, home, router]);

  if (userError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <EmptyState
          icon={RefreshCw}
          title="Can't reach WorkSight"
          description={userError}
          action={
            <button type="button" className={btn.secondary} onClick={reloadUser}>
              Try again
            </button>
          }
        />
      </div>
    );
  }
  if (!user || user.mustChangePassword || (!allowed && pathname === '/dashboard' && home !== '/dashboard')) {
    return <Spinner />;
  }
  if (!allowed) {
    return (
      <>
        <Header title="No access" subtitle="" />
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-[1440px] w-full mx-auto">
          <Card>
            <EmptyState
              icon={Lock}
              title="Your account can't open this page"
              description={`You're signed in as ${user.roleLabel}. Ask an admin if you need access.`}
              action={
                <Link href={home} className={btn.secondary}>
                  Go to your start page
                </Link>
              }
            />
          </Card>
        </main>
      </>
    );
  }
  return <>{children}</>;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getStoredToken()) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return <Spinner />;

  return (
    <ShellProvider>
      <div className="min-h-screen flex">
        <Sidebar />
        <div className="flex-1 min-w-0 flex flex-col">
          <AccessGate>{children}</AccessGate>
        </div>
      </div>
    </ShellProvider>
  );
}
