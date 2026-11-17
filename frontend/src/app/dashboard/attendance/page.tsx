'use client';

import React, { useEffect, useState } from 'react';
import { CalendarCheck, Clock, CheckCircle2, AlertTriangle, UserX, UserCheck, ScanFace, Hand, LogIn, LogOut, ShieldCheck, Info } from 'lucide-react';
import { Header } from '@/components/Header';
import { api } from '@/lib/api';
import { AutoAttendancePanel } from '@/components/AutoAttendancePanel';
import { RealTimePresenceBoard } from '@/components/RealTimePresenceBoard';

export default function AttendancePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [mySession, setMySession] = useState<any>(null);
  const [sessionActionLoading, setSessionActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const fetchSessionStatus = async () => {
    try {
      const res = await api.getMyTodaySession();
      if (res.success && res.data) {
        setMySession(res.data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchAttendance = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const res = await api.getTodayAttendance();
      if (res.success) {
        setData(res);
      }
      await fetchSessionStatus();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckIn = async () => {
    try {
      setSessionActionLoading(true);
      setActionMessage(null);
      const res = await api.checkIn(mySession?.employee?.id);
      if (res.success) {
        setActionMessage(`Checked in successfully at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        await fetchAttendance(true);
      }
    } catch (err: any) {
      setActionMessage(err.message || 'Check-in failed');
    } finally {
      setSessionActionLoading(false);
    }
  };

  const handleCheckOut = async () => {
    try {
      setSessionActionLoading(true);
      setActionMessage(null);
      const res = await api.checkOut(mySession?.employee?.id);
      if (res.success) {
        setActionMessage(`Checked out successfully at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        await fetchAttendance(true);
      }
    } catch (err: any) {
      setActionMessage(err.message || 'Check-out failed');
    } finally {
      setSessionActionLoading(false);
    }
  };

  useEffect(() => {
    fetchAttendance();
    // Keep the ledger current as the camera marks people in/out.
    const t = setInterval(() => fetchAttendance(true), 30000);
    return () => clearInterval(t);
  }, []);

  const stats = data?.stats || {
    totalEmployees: 5,
    presentCount: 3,
    lateCount: 1,
    absentCount: 2,
  };

  const records = data?.records || [];

  return (
    <>
      <Header
        title="Attendance Management & Daily Ledger"
        subtitle="Verified employee check-in logs, arrival timestamps, and work hours"
      />

      <main className="p-8 space-y-6">
        {/* KPI Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-slate-500 uppercase">Total Employees</p>
              <h4 className="text-xl font-bold text-slate-900 mt-0.5">{stats.totalEmployees}</h4>
            </div>
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <CalendarCheck className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-emerald-600 uppercase">Present Today</p>
              <h4 className="text-xl font-bold text-slate-900 mt-0.5">{stats.presentCount}</h4>
            </div>
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <UserCheck className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-amber-600 uppercase">Late Arrivals</p>
              <h4 className="text-xl font-bold text-slate-900 mt-0.5">{stats.lateCount}</h4>
            </div>
            <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
              <Clock className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold text-rose-600 uppercase">Absent</p>
              <h4 className="text-xl font-bold text-slate-900 mt-0.5">{stats.absentCount}</h4>
            </div>
            <div className="w-9 h-9 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center">
              <UserX className="w-5 h-5" />
            </div>
          </div>
        </div>

        {/* Employee Work Session Action Station (System B: Official Attendance) */}
        <div className="bg-gradient-to-r from-slate-900 to-indigo-950 rounded-2xl p-6 text-white shadow-md border border-slate-800">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-blue-500/20 text-blue-300 border border-blue-400/30">
                  System B — Official Work Session
                </span>
                <span className="flex items-center gap-1 text-[11px] text-slate-300">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Authorized Time Tracking
                </span>
              </div>
              <h2 className="text-xl font-bold text-white">
                {mySession?.employee?.fullName || 'Employee Attendance Console'}
              </h2>
              <p className="text-xs text-slate-400 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                Face recognition provides observational evidence. Official working hours require explicit Check-In / Check-Out.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {mySession?.openSession ? (
                <div className="flex items-center gap-4 bg-slate-800/80 px-4 py-2.5 rounded-xl border border-emerald-500/30">
                  <div className="text-right">
                    <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider block">Currently Checked In</span>
                    <span className="text-xs font-mono font-bold text-slate-200">
                      Since {new Date(mySession.openSession.checkInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <button
                    onClick={handleCheckOut}
                    disabled={sessionActionLoading}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition shadow-sm"
                  >
                    <LogOut className="w-4 h-4" />
                    {sessionActionLoading ? 'Checking out...' : 'Check Out Now'}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-4 bg-slate-800/80 px-4 py-2.5 rounded-xl border border-slate-700">
                  <div className="text-right">
                    <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Session Status</span>
                    <span className="text-xs font-bold text-slate-300">Checked Out / Idle</span>
                  </div>
                  <button
                    onClick={handleCheckIn}
                    disabled={sessionActionLoading}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition shadow-md"
                  >
                    <LogIn className="w-4 h-4" />
                    {sessionActionLoading ? 'Checking in...' : 'Check In Now'}
                  </button>
                </div>
              )}
            </div>
          </div>
          {actionMessage && (
            <div className="mt-3 text-xs px-3 py-1.5 bg-white/10 rounded-lg text-slate-200 border border-white/10">
              {actionMessage}
            </div>
          )}
        </div>

        {/* Real-Time Office Presence Monitor (System A: Observational Evidence) */}
        <RealTimePresenceBoard />

        <AutoAttendancePanel onActivity={() => fetchAttendance(true)} />

        {/* Ledger Table */}
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">Today&apos;s Attendance Logs</h3>
            <span className="text-xs font-mono text-slate-500">Date: {data?.date || new Date().toISOString().split('T')[0]}</span>
          </div>

          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3.5 px-4">Employee</th>
                <th className="py-3.5 px-4">Department</th>
                <th className="py-3.5 px-4">Arrival (Check-In)</th>
                <th className="py-3.5 px-4">Departure (Check-Out)</th>
                <th className="py-3.5 px-4">Total Office Time</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    Loading attendance ledger...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    No attendance records logged for today
                  </td>
                </tr>
              ) : (
                records.map((rec: any) => (
                  <tr key={rec.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-4 font-semibold text-slate-900">
                      {rec.employee?.fullName || 'Unknown Employee'}
                    </td>
                    <td className="py-3 px-4 text-slate-500">
                      {rec.employee?.department?.name || 'General'}
                    </td>
                    <td className="py-3 px-4 font-mono">
                      {rec.checkIn ? new Date(rec.checkIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="py-3 px-4 font-mono">
                      {rec.checkOut ? (
                        <>
                          {new Date(rec.checkOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          {rec.source === 'AUTO' && <span className="ml-1 text-[10px] text-slate-400 font-sans">last seen</span>}
                        </>
                      ) : 'In Office'}
                    </td>
                    <td className="py-3 px-4 text-slate-600">
                      {rec.totalMinutes > 0 ? `${Math.floor(rec.totalMinutes / 60)}h ${rec.totalMinutes % 60}m` : 'In Progress'}
                    </td>
                    <td className="py-3 px-4">
                      {rec.isLate ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                          <AlertTriangle className="w-3 h-3" /> Late Arrival
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <CheckCircle2 className="w-3 h-3" /> Present On Time
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {rec.source === 'AUTO' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700">
                          <ScanFace className="w-3.5 h-3.5" /> Camera
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                          <Hand className="w-3.5 h-3.5" /> Manual
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

