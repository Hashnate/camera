'use client';

/**
 * Attendance: today's check-ins (from the cameras or entered by hand), late arrivals, who is absent,
 * and the signed-in employee's own check-in / check-out. Live presence lives on Overview / Office Time.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarCheck, Clock, Hand, LogIn, LogOut, ScanFace, UserCheck, UserX } from 'lucide-react';
import { Header } from '@/components/Header';
import { api } from '@/lib/api';
import { Avatar, Card, CardHeader, CardLink, EmptyState, PresenceBadge, Skeleton, StatTile, btn } from '@/components/ui';
import { fmtDate, fmtMin, fmtTime } from '@/lib/format';

export default function AttendancePage() {
  const [data, setData] = useState<any>(null);
  const [employees, setEmployees] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mySession, setMySession] = useState<any>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const fetchAttendance = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const res = await api.getTodayAttendance();
      if (res.success) setData(res);
      setError(null);
      api.getMyTodaySession().then((r) => r.success && setMySession(r.data)).catch(() => {});
    } catch (err: any) {
      setError(err.message || 'Could not load attendance');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAttendance();
    api.getEmployees().then((r) => setEmployees(r.data.filter((e: any) => e.isActive))).catch(() => setEmployees([]));
    const t = setInterval(() => fetchAttendance(true), 30000);
    return () => clearInterval(t);
  }, []);

  const runSession = async (kind: 'in' | 'out') => {
    try {
      setSessionBusy(true);
      setActionMessage(null);
      const res = kind === 'in' ? await api.checkIn(mySession?.employee?.id) : await api.checkOut(mySession?.employee?.id);
      if (res.success) {
        setActionMessage(`${kind === 'in' ? 'Checked in' : 'Checked out'} at ${fmtTime(new Date().toISOString())}`);
        await fetchAttendance(true);
      }
    } catch (err: any) {
      setActionMessage(err.message || `Check-${kind} failed`);
    } finally {
      setSessionBusy(false);
    }
  };

  const stats = data?.stats;
  const records: any[] = data?.records || [];
  const presentIds = new Set(records.map((r) => r.employeeId || r.employee?.id));
  const absent = (employees ?? []).filter((e) => !presentIds.has(e.id));

  return (
    <>
      <Header subtitle={data?.date ? fmtDate(data.date, { weekday: 'long', day: 'numeric', month: 'long' }) : undefined} />

      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] w-full mx-auto">
        {error && (
          <div className="flex items-center gap-3 rounded-xl bg-amber-50 ring-1 ring-inset ring-amber-200 px-4 py-3 text-[13px] text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" /> {error}
          </div>
        )}

        <div className="grid gap-3 sm:gap-4 grid-cols-2 xl:grid-cols-4">
          <StatTile label="Employees" icon={CalendarCheck} value={stats ? stats.totalEmployees : <Skeleton className="h-7 w-10" />} />
          <StatTile
            label="Present"
            icon={UserCheck}
            value={stats ? stats.presentCount : <Skeleton className="h-7 w-10" />}
            sub={stats && stats.totalEmployees ? `${Math.round((stats.presentCount / stats.totalEmployees) * 100)}% of the team` : undefined}
          />
          <StatTile label="Late" icon={Clock} value={stats ? stats.lateCount : <Skeleton className="h-7 w-10" />} sub={stats ? 'After their start time' : undefined} />
          <StatTile label="Absent" icon={UserX} value={stats ? stats.absentCount : <Skeleton className="h-7 w-10" />} sub={stats ? 'Not checked in today' : undefined} />
        </div>

        {mySession?.employee && (
          <Card className="p-5">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Avatar name={mySession.employee.fullName} id={mySession.employee.id} />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-slate-900">Your work session</p>
                  <p className="text-[12.5px] text-slate-500">
                    {mySession.openSession
                      ? `${mySession.employee.fullName} · checked in since ${fmtTime(mySession.openSession.checkInAt)}`
                      : `${mySession.employee.fullName} · not checked in`}
                    . The cameras record sightings on their own; use this for your official working time.
                  </p>
                </div>
              </div>
              {mySession.openSession ? (
                <button type="button" onClick={() => runSession('out')} disabled={sessionBusy} className={btn.secondary}>
                  <LogOut className="w-4 h-4" /> {sessionBusy ? 'Checking out…' : 'Check out'}
                </button>
              ) : (
                <button type="button" onClick={() => runSession('in')} disabled={sessionBusy} className={btn.primary}>
                  <LogIn className="w-4 h-4" /> {sessionBusy ? 'Checking in…' : 'Check in'}
                </button>
              )}
            </div>
            {actionMessage && <p className="mt-3 text-[12.5px] text-slate-600">{actionMessage}</p>}
          </Card>
        )}

        <Card className="overflow-hidden">
          <CardHeader title="Today’s check-ins" description="Arrival and last time seen, per person" action={<CardLink href="/dashboard/office-time">Time inside →</CardLink>} />
          {loading ? (
            <div className="px-5 pb-5 space-y-3">
              <Skeleton className="h-11" />
              <Skeleton className="h-11" />
            </div>
          ) : records.length === 0 ? (
            <EmptyState icon={CalendarCheck} title="No one has checked in yet" description="Arrivals appear here as soon as a camera recognises someone, or when they check in by hand." />
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="bg-slate-50/70 border-y border-slate-100 text-[11.5px] text-slate-500">
                <tr>
                  <th className="py-2.5 px-5 font-medium">Employee</th>
                  <th className="py-2.5 px-3 font-medium">Arrived</th>
                  <th className="py-2.5 px-3 font-medium hidden sm:table-cell">Left / last seen</th>
                  <th className="py-2.5 px-3 font-medium hidden md:table-cell text-right">Span</th>
                  <th className="py-2.5 px-3 font-medium">Status</th>
                  <th className="py-2.5 px-5 font-medium hidden lg:table-cell">Recorded by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {records.map((rec) => (
                  <tr key={rec.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-5">
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar name={rec.employee?.fullName ?? '?'} id={rec.employee?.id} />
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 truncate">{rec.employee?.fullName ?? 'Unknown'}</p>
                          <p className="text-[12px] text-slate-500 truncate">{rec.employee?.department?.name ?? rec.employee?.employeeCode ?? ''}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 tabular-nums text-slate-800">{fmtTime(rec.checkIn)}</td>
                    <td className="py-3 px-3 tabular-nums text-slate-600 hidden sm:table-cell">{rec.checkOut ? fmtTime(rec.checkOut) : 'Still in'}</td>
                    <td className="py-3 px-3 tabular-nums text-right text-slate-800 hidden md:table-cell">{rec.totalMinutes > 0 ? fmtMin(rec.totalMinutes) : '—'}</td>
                    <td className="py-3 px-3">{rec.isLate ? <PresenceBadge tone="away">Late</PresenceBadge> : <PresenceBadge tone="in">On time</PresenceBadge>}</td>
                    <td className="py-3 px-5 hidden lg:table-cell">
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-600">
                        {rec.source === 'AUTO' ? <ScanFace className="w-4 h-4 text-slate-400" /> : <Hand className="w-4 h-4 text-slate-400" />}
                        {rec.source === 'AUTO' ? 'Camera' : 'By hand'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {employees && absent.length > 0 && (
          <Card>
            <CardHeader title="Not in today" description={`${absent.length} of ${employees.length} employees haven’t been seen`} />
            <ul className="px-5 pb-5 flex flex-wrap gap-2">
              {absent.map((e) => (
                <li key={e.id} className="inline-flex items-center gap-2 h-9 pl-1 pr-3 rounded-full bg-slate-50 ring-1 ring-inset ring-slate-200">
                  <Avatar size="sm" name={e.fullName} id={e.id} />
                  <span className="text-[13px] text-slate-700">{e.fullName}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </main>
    </>
  );
}
