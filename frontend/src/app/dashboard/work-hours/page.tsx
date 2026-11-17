'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  Timer,
  Users,
  Building2,
  Coffee,
  DoorOpen,
  HelpCircle,
  Activity,
  Calendar,
  RefreshCw,
  FileText,
  Download,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ShieldCheck,
  MapPin,
  Clock,
  LogOut,
  Sliders,
  X,
  Edit3,
  Eye,
  ArrowRight,
  UserCheck,
} from 'lucide-react';
import { Header } from '@/components/Header';
import {
  api,
  DailyTrackingItem,
  DailyTrackingSummary,
  DailyEmployeeDetail,
  DailyTrackingReport,
} from '@/lib/api';

const ZONE_COLORS: Record<string, { bg: string; text: string; border: string; label: string; icon: React.ElementType }> = {
  WORK_ROOM: {
    bg: 'bg-emerald-50 text-emerald-700',
    text: 'text-emerald-700',
    border: 'border-emerald-200',
    label: 'Working Room',
    icon: Building2,
  },
  LUNCH_ROOM: {
    bg: 'bg-amber-50 text-amber-700',
    text: 'text-amber-700',
    border: 'border-amber-200',
    label: 'Lunch Room',
    icon: Coffee,
  },
  PASSAGE: {
    bg: 'bg-blue-50 text-blue-700',
    text: 'text-blue-700',
    border: 'border-blue-200',
    label: 'Passage',
    icon: DoorOpen,
  },
  OUTSIDE: {
    bg: 'bg-purple-50 text-purple-700',
    text: 'text-purple-700',
    border: 'border-purple-200',
    label: 'Outside Office',
    icon: LogOut,
  },
  UNKNOWN: {
    bg: 'bg-slate-100 text-slate-600',
    text: 'text-slate-600',
    border: 'border-slate-200',
    label: 'Unknown / Unobserved',
    icon: HelpCircle,
  },
};

export default function WorkHoursDailyTrackingPage() {
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [employees, setEmployees] = useState<DailyTrackingItem[]>([]);
  const [summary, setSummary] = useState<DailyTrackingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Selected Employee Detail Modal
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [employeeDetail, setEmployeeDetail] = useState<DailyEmployeeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Admin Manual Correction Dialog
  const [correctionInterval, setCorrectionInterval] = useState<{ id: string; zoneId: string } | null>(null);
  const [newZoneId, setNewZoneId] = useState('WORK_ROOM');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  // End of Day Report Modal
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportData, setReportData] = useState<DailyTrackingReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Load Main Daily Tracking Data
  const fetchData = useCallback(async (showIndicator = false) => {
    try {
      if (showIndicator) setIsRefreshing(true);
      const [trackingRes, summaryRes] = await Promise.all([
        api.getDailyTracking(selectedDate),
        api.getDailyTrackingSummary(selectedDate),
      ]);
      if (trackingRes.success) {
        setEmployees(trackingRes.data || []);
      }
      if (summaryRes.success) {
        setSummary(summaryRes.summary);
      }
    } catch (err) {
      console.error('Failed to fetch daily tracking:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Real-time polling every 5 seconds for live day
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchData(false);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Load Individual Employee Detail
  const openEmployeeDetail = async (empId: string) => {
    setSelectedEmployeeId(empId);
    setDetailLoading(true);
    try {
      const res = await api.getDailyEmployeeDetail(empId, selectedDate);
      if (res.success) {
        setEmployeeDetail(res);
      }
    } catch (err) {
      console.error('Failed to fetch employee detail:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  // Open End of Day Report Modal
  const openReportModal = async () => {
    setShowReportModal(true);
    setReportLoading(true);
    try {
      const res = await api.getDailyTrackingReport(selectedDate);
      if (res.success) {
        setReportData(res);
      }
    } catch (err) {
      console.error('Failed to load report:', err);
    } finally {
      setReportLoading(false);
    }
  };

  // Submit Admin Manual Correction
  const handleCorrectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployeeId || !correctionInterval) return;
    if (!correctionReason.trim() || correctionReason.trim().length < 5) {
      setCorrectionError('A descriptive reason of at least 5 characters is mandatory.');
      return;
    }

    setCorrectionSubmitting(true);
    setCorrectionError(null);
    try {
      const res = await api.correctZoneInterval(selectedEmployeeId, {
        intervalId: correctionInterval.id,
        newZoneId: newZoneId,
        reason: correctionReason.trim(),
      });
      if (res.success) {
        setCorrectionInterval(null);
        setCorrectionReason('');
        // Refresh details and overview
        openEmployeeDetail(selectedEmployeeId);
        fetchData(false);
      }
    } catch (err: any) {
      setCorrectionError(err.message || 'Correction failed.');
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  // Export Report to CSV
  const handleExportCSV = () => {
    if (!reportData || !reportData.records) return;
    const headers = [
      'Employee Code',
      'Employee Name',
      'Department',
      'First Arrival',
      'Official Check-In',
      'Official Check-Out',
      'Attendance Status',
      'Working Room',
      'Lunch Room',
      'Outside Office',
      'Unknown Duration',
      'Total Observed',
      'Official Attendance',
    ];
    const rows = reportData.records.map((r) => [
      `"${r.employeeCode}"`,
      `"${r.employeeName}"`,
      `"${r.department}"`,
      `"${r.firstObservedAt ? new Date(r.firstObservedAt).toLocaleTimeString() : 'N/A'}"`,
      `"${r.attendanceCheckInAt ? new Date(r.attendanceCheckInAt).toLocaleTimeString() : 'N/A'}"`,
      `"${r.attendanceCheckOutAt ? new Date(r.attendanceCheckOutAt).toLocaleTimeString() : 'Open'}"`,
      `"${r.attendanceStatus}"`,
      `"${r.workRoomDuration}"`,
      `"${r.lunchRoomDuration}"`,
      `"${r.outsideDuration}"`,
      `"${r.unknownDuration}"`,
      `"${r.totalObservedDuration}"`,
      `"${r.officialAttendanceDuration}"`,
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `WorkSight_Daily_Report_${selectedDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <Header
        title="Daily Employee Tracking & Working-Hour Calculation"
        subtitle="Real-time multi-zone duration tracking, movement auditing, and verified hybrid attendance"
      />

      <main className="p-8 space-y-8 max-w-7xl mx-auto">
        {/* Top Control Bar: Date Selector & Actions */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4 w-full md:w-auto">
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2">
              <Calendar className="w-4 h-4 text-slate-500" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent text-sm font-semibold text-slate-800 focus:outline-none"
              />
            </div>
            <button
              onClick={() => setSelectedDate(new Date().toISOString().slice(0, 10))}
              className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                selectedDate === new Date().toISOString().slice(0, 10)
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              Today
            </button>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto justify-end">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 border transition-colors ${
                autoRefresh
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}
              title="Automatically refresh live tracking durations every 5s"
            >
              <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
              <span>Live Auto-Refresh: {autoRefresh ? 'ON (5s)' : 'PAUSED'}</span>
            </button>

            <button
              onClick={() => fetchData(true)}
              disabled={isRefreshing}
              className="p-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
              title="Refresh tracking data"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-blue-600' : ''}`} />
            </button>

            <Link
              href="/dashboard/work-hours/history"
              className="px-4 py-2 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Users className="w-4 h-4 text-blue-600" />
              <span>Employee History</span>
            </Link>

            <button
              onClick={openReportModal}
              className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-sm flex items-center gap-2 transition-colors"
            >
              <FileText className="w-4 h-4" />
              <span>End-of-Day Report</span>
            </button>
          </div>
        </div>

        {/* Aggregate KPI Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {/* Monitored Employees */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-slate-500 mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider">Monitored</span>
              <Users className="w-4 h-4 text-blue-600" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              {summary ? summary.totalTrackedEmployees : employees.filter((e) => e.hasTrackingSession).length}
              <span className="text-xs font-normal text-slate-400 ml-1">/ {employees.length}</span>
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">Enrolled employees</p>
          </div>

          {/* Working Room Occupancy */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-emerald-600 mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider">Working Room</span>
              <Building2 className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              {summary ? summary.currentlyInWorkingRoom : employees.filter((e) => e.currentZoneId === 'WORK_ROOM').length}
            </p>
            <p className="text-[11px] text-emerald-600 font-medium mt-0.5">Desks active</p>
          </div>

          {/* Lunch Room Occupancy */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-amber-600 mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider">Lunch Room</span>
              <Coffee className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              {summary ? summary.currentlyInLunchRoom : employees.filter((e) => e.currentZoneId === 'LUNCH_ROOM').length}
            </p>
            <p className="text-[11px] text-amber-600 font-medium mt-0.5">Dining / Break</p>
          </div>

          {/* Outside Office */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-purple-600 mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider">Outside Office</span>
              <LogOut className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">
              {summary ? summary.currentlyOutside : employees.filter((e) => e.currentZoneId === 'OUTSIDE').length}
            </p>
            <p className="text-[11px] text-purple-600 font-medium mt-0.5">Out of building</p>
          </div>

          {/* Total Working Room Hours */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-blue-600 mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider">Total Work Time</span>
              <Clock className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{summary?.totalWorkingRoomFormatted || '0m'}</p>
            <p className="text-[11px] text-slate-400 mt-0.5">Observed in Work Room</p>
          </div>

          {/* Official Attendance Total */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-indigo-600 mb-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider">Total Attendance</span>
              <ShieldCheck className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{summary?.totalAttendanceFormatted || '0m'}</p>
            <p className="text-[11px] text-indigo-600 font-medium mt-0.5">Payroll Check-in</p>
          </div>
        </div>

        {/* DAILY EMPLOYEE TRACKING SECTION */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-600"></span>
                <h2 className="text-lg font-bold text-slate-900 uppercase tracking-wide">
                  Daily Employee Tracking
                </h2>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Individual persistent tracking sessions tied to permanent Employee UUIDs with live server-side zone durations.
              </p>
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Observed &lt;60s
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                Stale &gt;60s (Unknown)
              </span>
            </div>
          </div>

          {/* Table / Grid */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/75 text-[11px] font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200/80">
                  <th className="py-3.5 px-6">Employee</th>
                  <th className="py-3.5 px-4">Current Verified Zone</th>
                  <th className="py-3.5 px-4">Freshness</th>
                  <th className="py-3.5 px-4">Arrival / Check-In</th>
                  <th className="py-3.5 px-4">Working Room</th>
                  <th className="py-3.5 px-4">Lunch Room</th>
                  <th className="py-3.5 px-4">Outside</th>
                  <th className="py-3.5 px-4">Unknown</th>
                  <th className="py-3.5 px-4">Official Att.</th>
                  <th className="py-3.5 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {employees.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-400 text-sm">
                      No employees registered in the system.
                    </td>
                  </tr>
                ) : (
                  employees.map((emp) => {
                    const zoneConf = ZONE_COLORS[emp.currentZoneId] || ZONE_COLORS.UNKNOWN;
                    const ZoneIcon = zoneConf.icon;
                    const durs = emp.durations;

                    return (
                      <tr
                        key={emp.employeeId}
                        className="hover:bg-slate-50/80 transition-colors group cursor-pointer"
                        onClick={() => openEmployeeDetail(emp.employeeId)}
                      >
                        {/* Employee Name & Code */}
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white font-bold flex items-center justify-center text-xs shadow-sm flex-shrink-0">
                              {emp.employeeName
                                .split(' ')
                                .map((n) => n[0])
                                .slice(0, 2)
                                .join('')}
                            </div>
                            <div>
                              <p className="font-semibold text-slate-900 group-hover:text-blue-600 transition-colors">
                                {emp.employeeName}
                              </p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="font-mono text-xs text-slate-500 font-medium">
                                  {emp.employeeCode}
                                </span>
                                <span className="text-[10px] text-slate-400">• {emp.departmentName}</span>
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Current Verified Zone */}
                        <td className="py-4 px-4">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${zoneConf.bg} ${zoneConf.border}`}
                          >
                            <ZoneIcon className="w-3.5 h-3.5" />
                            <span>{zoneConf.label}</span>
                          </span>
                        </td>

                        {/* Freshness Badge */}
                        <td className="py-4 px-4">
                          {emp.currentObservationStatus === 'OBSERVED_RECENTLY' ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                              Live ({durs.secondsSinceLastSeen}s ago)
                            </span>
                          ) : emp.currentObservationStatus === 'NOT_RECENTLY_OBSERVED' ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 font-medium">
                              <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                              Stale ({Math.round(durs.secondsSinceLastSeen / 60)}m ago)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 font-medium">
                              <span className="w-2 h-2 rounded-full bg-slate-300"></span>
                              Not Seen Today
                            </span>
                          )}
                        </td>

                        {/* First Arrival & Check-In */}
                        <td className="py-4 px-4 text-xs font-medium text-slate-700">
                          <div>
                            <span className="text-slate-400 text-[10px] block">First Arrival:</span>
                            {emp.firstObservedAt
                              ? new Date(emp.firstObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                              : '—'}
                          </div>
                          {emp.attendanceCheckInAt && (
                            <div className="mt-1 text-[11px] text-emerald-600 font-medium">
                              Check-In: {new Date(emp.attendanceCheckInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          )}
                        </td>

                        {/* Working Room Duration */}
                        <td className="py-4 px-4 font-semibold text-slate-900 font-mono text-xs">
                          <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                            {durs.workRoomFormatted}
                          </span>
                        </td>

                        {/* Lunch Room Duration */}
                        <td className="py-4 px-4 font-semibold text-slate-800 font-mono text-xs">
                          {durs.lunchRoomSeconds > 0 ? (
                            <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                              {durs.lunchRoomFormatted}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>

                        {/* Outside Office Duration */}
                        <td className="py-4 px-4 font-semibold text-slate-800 font-mono text-xs">
                          {durs.outsideOfficeSeconds > 0 ? (
                            <span className="text-purple-700 bg-purple-50 px-2 py-0.5 rounded">
                              {durs.outsideOfficeFormatted}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>

                        {/* Unknown Duration */}
                        <td className="py-4 px-4 font-semibold text-slate-800 font-mono text-xs">
                          {durs.unknownSeconds > 0 ? (
                            <span className="text-rose-700 bg-rose-50 px-2 py-0.5 rounded">
                              {durs.unknownFormatted}
                            </span>
                          ) : (
                            <span className="text-slate-400">0m</span>
                          )}
                        </td>

                        {/* Total Attendance */}
                        <td className="py-4 px-4 font-bold text-slate-900 font-mono text-xs">
                          {durs.officialAttendanceSeconds > 0 ? (
                            durs.officialAttendanceFormatted
                          ) : (
                            <span className="text-slate-400 font-normal">Pending</span>
                          )}
                        </td>

                        {/* Action: Open Timeline */}
                        <td className="py-4 px-6 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openEmployeeDetail(emp.employeeId);
                            }}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors inline-flex items-center gap-1 text-xs font-semibold"
                          >
                            <span>Details</span>
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* INDIVIDUAL EMPLOYEE DETAIL MODAL / DRAWER */}
      {selectedEmployeeId && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-2xl bg-white h-full shadow-2xl overflow-y-auto flex flex-col">
            {/* Header */}
            <div className="p-6 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white/95 backdrop-blur z-10">
              <div>
                <span className="text-[10px] font-semibold text-blue-600 uppercase tracking-wider">
                  Employee Daily Profile & Tracking Audit
                </span>
                <h3 className="text-xl font-bold text-slate-900 mt-0.5">
                  {employeeDetail?.employee.name || 'Loading...'}
                </h3>
                <p className="text-xs text-slate-500 font-mono mt-0.5">
                  ID: {employeeDetail?.employee.id} • Code: {employeeDetail?.employee.code}
                </p>
              </div>
              <button
                onClick={() => {
                  setSelectedEmployeeId(null);
                  setEmployeeDetail(null);
                }}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            {detailLoading ? (
              <div className="p-12 flex flex-col items-center justify-center text-slate-400 gap-3">
                <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
                <p className="text-sm">Loading chronological movement telemetry...</p>
              </div>
            ) : !employeeDetail ? (
              <div className="p-8 text-center text-slate-500">Failed to load telemetry.</div>
            ) : (
              <div className="p-6 space-y-6 flex-1">
                {/* Zone Duration Breakdown Visual Bar */}
                <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200/80">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">
                    Zone Duration Breakdown ({employeeDetail.workDate})
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                    <div className="bg-white p-3 rounded-xl border border-slate-200">
                      <span className="text-[10px] text-emerald-700 font-semibold uppercase">Working Room</span>
                      <p className="text-lg font-bold text-slate-900 mt-1">{employeeDetail.durations.workRoomFormatted}</p>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-slate-200">
                      <span className="text-[10px] text-amber-700 font-semibold uppercase">Lunch Room</span>
                      <p className="text-lg font-bold text-slate-900 mt-1">{employeeDetail.durations.lunchRoomFormatted}</p>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-slate-200">
                      <span className="text-[10px] text-purple-700 font-semibold uppercase">Outside Office</span>
                      <p className="text-lg font-bold text-slate-900 mt-1">{employeeDetail.durations.outsideOfficeFormatted}</p>
                    </div>
                    <div className="bg-white p-3 rounded-xl border border-slate-200">
                      <span className="text-[10px] text-rose-700 font-semibold uppercase">Unknown Time</span>
                      <p className="text-lg font-bold text-slate-900 mt-1">{employeeDetail.durations.unknownFormatted}</p>
                    </div>
                  </div>
                </div>

                {/* Chronological Doorway Movement Timeline */}
                <div>
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center justify-between mb-4">
                    <span>Verified Movement Events ({employeeDetail.timeline.length})</span>
                    <span className="text-[11px] font-normal text-slate-400">Directional Line Crossings</span>
                  </h4>

                  {employeeDetail.timeline.length === 0 ? (
                    <div className="p-8 text-center text-slate-400 bg-slate-50 rounded-xl text-xs border border-dashed border-slate-200">
                      No doorway movements recorded for this date.
                    </div>
                  ) : (
                    <div className="space-y-3 relative before:absolute before:inset-0 before:left-3.5 before:w-0.5 before:bg-slate-200">
                      {employeeDetail.timeline.map((m, idx) => (
                        <div key={m.id || idx} className="relative flex items-start gap-4 pl-8">
                          <span className="absolute left-2 top-1.5 w-3.5 h-3.5 rounded-full bg-blue-600 border-2 border-white shadow-sm" />
                          <div className="bg-white p-3.5 rounded-xl border border-slate-200/80 shadow-sm flex-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold text-slate-900">{m.eventType}</span>
                              <span className="text-[11px] text-slate-500 font-mono">
                                {new Date(m.timestamp).toLocaleTimeString()}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-xs text-slate-600">
                              <span>
                                From <b className="text-slate-800">{m.fromZoneId || 'Unknown'}</b> to{' '}
                                <b className="text-slate-800">{m.toZoneId}</b>
                              </span>
                              {m.crossingLineId && (
                                <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] font-mono">
                                  {m.crossingLineId}
                                </span>
                              )}
                            </div>
                            <div className="mt-2 text-[10px] text-slate-400 flex items-center gap-3">
                              <span>Camera: {m.sourceCameraId || 'Dual Channel 1'}</span>
                              <span>Confidence: {Math.round((m.verificationConfidence || 1) * 100)}%</span>
                              {m.cameraTrackId && <span>Track #{m.cameraTrackId}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Contiguous Zone Intervals & Admin Correction */}
                <div>
                  <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center justify-between mb-4">
                    <span>Contiguous Zone Intervals ({employeeDetail.intervals.length})</span>
                    <span className="text-[11px] font-normal text-slate-400">Duration Logs</span>
                  </h4>

                  <div className="space-y-2.5">
                    {employeeDetail.intervals.map((inv) => (
                      <div
                        key={inv.id}
                        className="bg-white p-3.5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-900">{inv.zoneId}</span>
                            <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                              {inv.durationFormatted}
                            </span>
                            {inv.isOngoing && (
                              <span className="text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold">
                                Ongoing
                              </span>
                            )}
                            {inv.verificationStatus === 'MANUALLY_CORRECTED' && (
                              <span className="text-[10px] text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded font-semibold">
                                Corrected
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1">
                            {new Date(inv.enteredAt).toLocaleTimeString()} —{' '}
                            {inv.exitedAt ? new Date(inv.exitedAt).toLocaleTimeString() : 'Current Time'}
                          </p>
                        </div>

                        <button
                          onClick={() => {
                            setCorrectionInterval({ id: inv.id, zoneId: inv.zoneId });
                            setNewZoneId(inv.zoneId === 'WORK_ROOM' ? 'LUNCH_ROOM' : 'WORK_ROOM');
                            setCorrectionReason('');
                            setCorrectionError(null);
                          }}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-600 hover:text-blue-600 hover:bg-blue-50 border border-slate-200 rounded-lg transition-colors flex items-center gap-1"
                        >
                          <Edit3 className="w-3 h-3" />
                          <span>Correct</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ADMIN MANUAL CORRECTION MODAL */}
      {correctionInterval && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-blue-600" />
                <span>Administrator Zone Correction</span>
              </h3>
              <button
                onClick={() => setCorrectionInterval(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCorrectionSubmit} className="mt-4 space-y-4">
              <p className="text-xs text-slate-500">
                You are modifying a verified camera interval. Corrections are permanently audited with your user ID and mandatory reason.
              </p>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">New Target Zone</label>
                <select
                  value={newZoneId}
                  onChange={(e) => setNewZoneId(e.target.value)}
                  className="w-full text-sm font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="WORK_ROOM">Working Room (Desk Cluster)</option>
                  <option value="LUNCH_ROOM">Lunch Room (Left Doorway)</option>
                  <option value="PASSAGE">Shared Passage & Corridor</option>
                  <option value="OUTSIDE">Outside Office (External)</option>
                  <option value="UNKNOWN">Unknown / Unobserved</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">
                  Mandatory Justification / Reason <span className="text-rose-500">*</span>
                </label>
                <textarea
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  placeholder="e.g. Employee attended team sprint planning meeting in lunch room..."
                  rows={3}
                  className="w-full text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {correctionError && (
                <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{correctionError}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setCorrectionInterval(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={correctionSubmitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl shadow-md flex items-center gap-2"
                >
                  {correctionSubmitting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>Save Correction & Audit</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* END-OF-DAY REPORT MODAL */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] shadow-2xl border border-slate-200 flex flex-col">
            <div className="p-6 border-b border-slate-200 flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-blue-600 uppercase tracking-wider">
                  WorkSight Daily Activity Audit
                </span>
                <h3 className="text-xl font-bold text-slate-900 mt-0.5">
                  End-of-Day Report — {selectedDate}
                </h3>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleExportCSV}
                  disabled={!reportData || reportData.records.length === 0}
                  className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl shadow-sm flex items-center gap-2 transition-colors disabled:opacity-50"
                >
                  <Download className="w-4 h-4" />
                  <span>Export CSV</span>
                </button>
                <button
                  onClick={() => setShowReportModal(false)}
                  className="p-2 text-slate-400 hover:text-slate-600 rounded-xl"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 flex-1">
              {reportLoading ? (
                <div className="py-16 text-center text-slate-400 flex flex-col items-center gap-3">
                  <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
                  <p className="text-sm">Synthesizing end-of-day report...</p>
                </div>
              ) : !reportData ? (
                <p className="text-center text-slate-400">Failed to load report.</p>
              ) : (
                <>
                  {/* Exceptions Summary */}
                  {reportData.exceptions.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                      <h4 className="text-xs font-bold text-amber-800 uppercase flex items-center gap-2 mb-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />
                        <span>Tracking Exceptions Detected ({reportData.exceptions.length})</span>
                      </h4>
                      <ul className="space-y-1.5 text-xs text-amber-800">
                        {reportData.exceptions.map((ex, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="font-bold">• {ex.employeeName}:</span>
                            <span>{ex.details}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Summary Table */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase border-b border-slate-200">
                        <tr>
                          <th className="p-3">Employee</th>
                          <th className="p-3">First Arrival</th>
                          <th className="p-3">Check-In</th>
                          <th className="p-3">Check-Out</th>
                          <th className="p-3">Working Room</th>
                          <th className="p-3">Lunch</th>
                          <th className="p-3">Outside</th>
                          <th className="p-3">Unknown</th>
                          <th className="p-3">Attendance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {reportData.records.map((r) => (
                          <tr key={r.employeeId} className="hover:bg-slate-50/80">
                            <td className="p-3 font-semibold text-slate-900">
                              {r.employeeName}
                              <span className="block text-[10px] text-slate-400 font-normal">{r.employeeCode}</span>
                            </td>
                            <td className="p-3 font-mono">
                              {r.firstObservedAt ? new Date(r.firstObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                            </td>
                            <td className="p-3 font-mono">
                              {r.attendanceCheckInAt ? new Date(r.attendanceCheckInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                            </td>
                            <td className="p-3 font-mono">
                              {r.attendanceCheckOutAt ? new Date(r.attendanceCheckOutAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Open'}
                            </td>
                            <td className="p-3 font-mono font-semibold text-emerald-700">{r.workRoomDuration}</td>
                            <td className="p-3 font-mono text-amber-700">{r.lunchRoomDuration}</td>
                            <td className="p-3 font-mono text-purple-700">{r.outsideDuration}</td>
                            <td className="p-3 font-mono text-rose-700">{r.unknownDuration}</td>
                            <td className="p-3 font-mono font-bold text-slate-900">{r.officialAttendanceDuration}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
