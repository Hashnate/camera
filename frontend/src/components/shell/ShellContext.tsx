'use client';

/** App-shell state shared by the sidebar, the top bar and pages: signed-in user and their access, live system
 * status, mobile nav. */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, RecognitionStatus, type Permission, type SessionUser } from '@/lib/api';

export type ShellUser = SessionUser;

export type SystemHealth = 'checking' | 'live' | 'degraded' | 'offline';

interface ShellState {
  user: SessionUser | null;
  /** Set when the signed-in user couldn't be loaded (server down). */
  userError: string | null;
  reloadUser: () => void;
  /** Whether the signed-in person may do something (mirrors the server's rules). */
  can: (perm: Permission) => boolean;
  status: RecognitionStatus | null;
  health: SystemHealth;
  refreshStatus: () => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellState | null>(null);

/** live: recognition running on at least one channel. degraded: service up but no channel streaming. */
export function healthOf(status: RecognitionStatus | null): SystemHealth {
  if (!status) return 'checking';
  if (!status.reachable) return 'offline';
  const channels = status.channels ?? [];
  if (status.running && channels.some((c) => c.state === 'running')) return 'live';
  return 'degraded';
}

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const [status, setStatus] = useState<RecognitionStatus | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const can = useCallback((perm: Permission) => !!user?.permissions.includes(perm), [user]);
  const seesReports = can('reports.view');

  const reloadUser = useCallback(() => {
    setUserError(null);
    api
      .getMe()
      .then((r) => setUser(r.user))
      .catch((e) => setUserError(e.message || 'Could not reach WorkSight'));
  }, []);

  const refreshStatus = useCallback(() => {
    api
      .getRecognitionStatus()
      .then((r) => setStatus(r.data))
      .catch(() => setStatus({ reachable: false, error: 'Backend unreachable' }));
  }, []);

  useEffect(() => {
    reloadUser();
  }, [reloadUser]);

  // Only people who see reports see (and need) the live system status.
  useEffect(() => {
    if (!seesReports) return;
    refreshStatus();
    const t = setInterval(refreshStatus, 30000);
    return () => clearInterval(t);
  }, [seesReports, refreshStatus]);

  return (
    <ShellContext.Provider
      value={{ user, userError, reloadUser, can, status, health: healthOf(status), refreshStatus, mobileNavOpen, setMobileNavOpen }}
    >
      {children}
    </ShellContext.Provider>
  );
}

export function useShell(): ShellState {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside <ShellProvider>');
  return ctx;
}

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  OFFICE_ADMIN: 'Admin',
  HR_MANAGER: 'HR manager',
  SUPERVISOR: 'Supervisor',
  VIEWER: 'Viewer',
  EMPLOYEE: 'Employee',
};
