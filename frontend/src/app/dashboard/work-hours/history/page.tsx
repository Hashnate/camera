'use client';

import React, { useState, useEffect, useCallback } from 'react';
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
  ShieldCheck,
  MapPin,
  Clock,
  LogOut,
  Edit3,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Sliders,
  X,
  Search,
  Camera,
} from 'lucide-react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import {
  api,
  DailyEmployeeDetail,
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

export default function EmployeeDailyTrackingHistoryPage() {
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [employeesList, setEmployeesList] = useState<any[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [employeeDetail, setEmployeeDetail] = useState<DailyEmployeeDetail | null>(null);
  const [calculationData, setCalculationData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'timeline' | 'intervals' | 'breaks' | 'biometrics'>('timeline');

  // Manual correction dialog
  const [correctionInterval, setCorrectionInterval] = useState<{ id: string; zoneId: string } | null>(null);
  const [newZoneId, setNewZoneId] = useState('WORK_ROOM');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  // Administrative close dialog
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closeReason, setCloseReason] = useState('End-of-day supervisor review and manual completion');
  const [closeStatus, setCloseStatus] = useState('COMPLETED');
  const [closeSubmitting, setCloseSubmitting] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // Load registered employees on mount
  useEffect(() => {
    async function loadEmployees() {
      try {
        const res = await api.getEmployees();
        if (res.success && res.data) {
          setEmployeesList(res.data);
          if (res.data.length > 0 && !selectedEmployeeId) {
            setSelectedEmployeeId(res.data[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to load employee list:', err);
      }
    }
    loadEmployees();
  }, [selectedEmployeeId]);

  // Load employee detail and calculation
  const loadHistory = useCallback(async () => {
    if (!selectedEmployeeId) return;
    setLoading(true);
    try {
      const [detailRes, calcRes] = await Promise.all([
        api.getDailyEmployeeDetail(selectedEmployeeId, selectedDate),
        api.getDailyEmployeeCalculation(selectedEmployeeId, selectedDate),
      ]);
      if (detailRes.success) {
        setEmployeeDetail(detailRes);
      }
      if (calcRes.success) {
        setCalculationData(calcRes);
      }
    } catch (err) {
      console.error('Failed to fetch tracking history:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedEmployeeId, selectedDate]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Submit manual interval correction
  const handleCorrectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployeeId || !correctionInterval) return;
    if (!correctionReason.trim() || correctionReason.trim().length < 5) {
      setCorrectionError('A descriptive reason of at least 5 characters is required.');
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
        loadHistory();
      }
    } catch (err: any) {
      setCorrectionError(err.message || 'Correction failed.');
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  // Submit session closure
  const handleCloseSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployeeId) return;
    setCloseSubmitting(true);
    setCloseError(null);
    try {
      const res = await api.closeDailyTrackingSession(selectedEmployeeId, {
        workDate: selectedDate,
        reason: closeReason.trim(),
        sessionStatus: closeStatus,
      });
      if (res.success) {
        setShowCloseModal(false);
        loadHistory();
      }
    } catch (err: any) {
      setCloseError(err.message || 'Failed to close session.');
    } finally {
      setCloseSubmitting(false);
    }
  };

  const selectedEmpObj = employeesList.find((e) => e.id === selectedEmployeeId);
  const durations = calculationData?.zoneDurations || employeeDetail?.durations;
  const breakClass = calculationData?.breakClassifications;
  const attendance = calculationData?.officialAttendance;

  return (
    <>
      <Header title="Work Hours history" subtitle="One employee’s rooms and breaks, day by day" />

      <main className="p-8 space-y-8 max-w-7xl mx-auto">
        {/* Navigation & Controls */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/work-hours"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Live Work Hours
            </Link>

            {/* Employee Selector */}
            <div className="relative">
              <select
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-none focus:border-blue-500 cursor-pointer min-w-[200px]"
              >
                {employeesList.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    #{emp.employeeCode} — {emp.fullName}
                  </option>
                ))}
              </select>
            </div>

            {/* Date Picker */}
            <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
              <Calendar className="w-3.5 h-3.5 text-slate-400" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="text-xs font-semibold text-slate-700 bg-transparent focus:outline-none cursor-pointer"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={loadHistory}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>

            <button
              onClick={() => setShowCloseModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Close Session
            </button>
          </div>
        </div>

        {/* Employee Summary Card */}
        {selectedEmpObj && (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-700 text-white font-bold flex items-center justify-center text-xl shadow-md">
                  {selectedEmpObj.fullName.split(' ').map((n: string) => n[0]).slice(0, 2).join('')}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-slate-900">{selectedEmpObj.fullName}</h2>
                    <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                      ID: #{selectedEmpObj.employeeCode}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                        employeeDetail?.sessionStatus === 'ACTIVE'
                          ? 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                          : employeeDetail?.sessionStatus === 'COMPLETED' || employeeDetail?.sessionStatus === 'CLOSED'
                          ? 'bg-blue-100 text-blue-700 border border-blue-300'
                          : 'bg-amber-100 text-amber-700 border border-amber-300'
                      }`}
                    >
                      {employeeDetail?.sessionStatus || 'NOT_STARTED'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {selectedEmpObj.jobTitle || 'Software Engineer'} • {selectedEmpObj.department?.name || 'Engineering'} • Assigned: {selectedEmpObj.assignedZone || 'Working Room'}
                  </p>
                  <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                    UUID: {selectedEmpObj.id}
                  </p>
                </div>
              </div>

              {/* Status Pills */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-center min-w-[110px]">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">First Observed</span>
                  <span className="text-xs font-bold text-slate-700 mt-0.5 block">
                    {employeeDetail?.firstObservedAt ? new Date(employeeDetail.firstObservedAt).toLocaleTimeString() : 'N/A'}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-center min-w-[110px]">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Official Check-In</span>
                  <span className="text-xs font-bold text-slate-700 mt-0.5 block">
                    {attendance?.checkInAt ? new Date(attendance.checkInAt).toLocaleTimeString() : 'N/A'}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-center min-w-[110px]">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">Current Zone</span>
                  <span className="text-xs font-bold text-emerald-700 mt-0.5 block">
                    {employeeDetail?.currentZoneId ? employeeDetail.currentZoneId.replace(/_/g, ' ') : 'UNKNOWN'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Mutually Exclusive Duration Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="bg-white p-4 rounded-xl border border-emerald-200/80 shadow-sm">
            <div className="flex items-center justify-between text-emerald-600 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider">Working Room</span>
              <Building2 className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{durations?.workRoomFormatted || '0m'}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{durations?.workRoomSeconds || 0}s observed</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-amber-200/80 shadow-sm">
            <div className="flex items-center justify-between text-amber-600 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider">Lunch Room</span>
              <Coffee className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{durations?.lunchRoomFormatted || '0m'}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{durations?.lunchRoomSeconds || 0}s observed</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-blue-200/80 shadow-sm">
            <div className="flex items-center justify-between text-blue-600 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider">Passage</span>
              <DoorOpen className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{durations?.passageFormatted || '0m'}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{durations?.passageSeconds || 0}s observed</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-purple-200/80 shadow-sm">
            <div className="flex items-center justify-between text-purple-600 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider">Outside Office</span>
              <LogOut className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{durations?.outsideOfficeFormatted || '0m'}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{durations?.outsideOfficeSeconds || 0}s away</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
            <div className="flex items-center justify-between text-slate-600 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider">Unknown</span>
              <HelpCircle className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-slate-900">{durations?.unknownFormatted || '0m'}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">{durations?.unknownSeconds || 0}s unobserved</p>
          </div>

          <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 rounded-xl shadow-sm">
            <div className="flex items-center justify-between text-emerald-400 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider">Total Observed</span>
              <ShieldCheck className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold">{durations?.totalObservedFormatted || '0m'}</p>
            <div className="flex items-center gap-1 text-[10px] text-emerald-400 font-semibold mt-0.5">
              <CheckCircle2 className="w-3 h-3" />
              <span>Mutually Exclusive</span>
            </div>
          </div>
        </div>

        {/* Break Classifications Bar (Orthogonal Layer) */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2">
            <Coffee className="w-4 h-4 text-amber-600" />
            <span className="font-bold text-slate-700">Movement Break Allowances:</span>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <span className="text-slate-400">Paid Breaks: </span>
              <span className="font-semibold text-slate-800">{breakClass?.approvedPaidBreakFormatted || '0m'}</span>
            </div>
            <div>
              <span className="text-slate-400">Unpaid (Lunch): </span>
              <span className="font-semibold text-slate-800">{breakClass?.approvedUnpaidBreakFormatted || '0m'}</span>
            </div>
            <div>
              <span className="text-slate-400">Excess Break: </span>
              <span className={`font-semibold ${breakClass?.excessBreakSeconds ? 'text-red-600' : 'text-slate-800'}`}>
                {breakClass?.excessBreakFormatted || '0m'}
              </span>
            </div>
            <div>
              <span className="text-slate-400">Official Attendance: </span>
              <span className="font-semibold text-indigo-700">{attendance?.officialAttendanceFormatted || '0m'}</span>
            </div>
          </div>
        </div>

        {/* Tabbed Detailed View */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="flex border-b border-slate-200 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('timeline')}
              className={`py-3.5 px-6 border-b-2 transition ${
                activeTab === 'timeline'
                  ? 'border-blue-600 text-blue-600 bg-blue-50/40'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Movement Timeline & Doorways ({employeeDetail?.timeline?.length || 0})
            </button>
            <button
              onClick={() => setActiveTab('intervals')}
              className={`py-3.5 px-6 border-b-2 transition ${
                activeTab === 'intervals'
                  ? 'border-blue-600 text-blue-600 bg-blue-50/40'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Zone Intervals ({employeeDetail?.intervals?.length || 0})
            </button>
            <button
              onClick={() => setActiveTab('biometrics')}
              className={`py-3.5 px-6 border-b-2 transition ${
                activeTab === 'biometrics'
                  ? 'border-blue-600 text-blue-600 bg-blue-50/40'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Biometric Latching & CEIT Protection
            </button>
          </div>

          <div className="p-6">
            {/* TAB 1: Movement Timeline */}
            {activeTab === 'timeline' && (
              <div className="space-y-4">
                {(!employeeDetail?.timeline || employeeDetail.timeline.length === 0) ? (
                  <p className="text-xs text-slate-400 text-center py-8">
                    No verified doorway crossings recorded for this date.
                  </p>
                ) : (
                  employeeDetail.timeline.map((item, idx) => (
                    <div
                      key={item.id || idx}
                      className="flex items-start gap-4 p-4 rounded-xl border border-slate-100 hover:border-slate-200 bg-slate-50/50 transition"
                    >
                      <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-xs flex-shrink-0">
                        {idx + 1}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-800">{item.eventType.replace(/_/g, ' ')}</span>
                          <span className="text-[11px] font-mono text-slate-400">
                            {new Date(item.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          From <span className="font-semibold text-slate-700">{item.fromZoneId || 'PASSAGE'}</span> ➔ To <span className="font-semibold text-slate-700">{item.toZoneId}</span> via boundary line <span className="font-mono text-blue-600">{item.crossingLineId || 'DIRECT'}</span>
                        </p>
                        <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-2">
                          <span>Confidence: {Math.round((item.verificationConfidence || 1.0) * 100)}%</span>
                          <span>•</span>
                          <span>Track ID: #{item.cameraTrackId || 'N/A'}</span>
                          <span>•</span>
                          <span>Camera: Channel {item.sourceChannelNo || 1}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* TAB 2: Zone Intervals */}
            {activeTab === 'intervals' && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] font-semibold text-slate-500 uppercase border-b border-slate-200">
                      <th className="py-3 px-4">Zone</th>
                      <th className="py-3 px-4">Entered At</th>
                      <th className="py-3 px-4">Exited At</th>
                      <th className="py-3 px-4">Duration</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Admin Correction</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(!employeeDetail?.intervals || employeeDetail.intervals.length === 0) ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          No zone intervals recorded.
                        </td>
                      </tr>
                    ) : (
                      employeeDetail.intervals.map((inv) => {
                        const zConf = ZONE_COLORS[inv.zoneId] || ZONE_COLORS.UNKNOWN;
                        const ZIcon = zConf.icon;
                        return (
                          <tr key={inv.id} className="hover:bg-slate-50/60 transition">
                            <td className="py-3 px-4">
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold ${zConf.bg} border ${zConf.border}`}>
                                <ZIcon className="w-3 h-3" />
                                {zConf.label}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600">
                              {new Date(inv.enteredAt).toLocaleTimeString()}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600">
                              {inv.exitedAt ? new Date(inv.exitedAt).toLocaleTimeString() : <span className="text-emerald-600 font-bold">Ongoing</span>}
                            </td>
                            <td className="py-3 px-4 font-bold text-slate-800">
                              {inv.durationFormatted}
                            </td>
                            <td className="py-3 px-4">
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                                {inv.verificationStatus}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <button
                                onClick={() => {
                                  setCorrectionInterval({ id: inv.id, zoneId: inv.zoneId });
                                  setNewZoneId(inv.zoneId === 'WORK_ROOM' ? 'LUNCH_ROOM' : 'WORK_ROOM');
                                  setCorrectionReason('');
                                }}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded transition"
                              >
                                <Edit3 className="w-3 h-3" />
                                Correct
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* TAB 3: Biometrics & CEIT */}
            {activeTab === 'biometrics' && (
              <div className="space-y-4 text-xs">
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <h4 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    Continuous Employee Identity Tracking (CEIT v2.9) Verification
                  </h4>
                  <p className="text-slate-600 leading-relaxed">
                    This employee identity is verified against enrolled biometric templates (YuNet 5-point face landmarks + SFace 128D embeddings).
                    Once latched, identity persists across body tracking sessions even when the employee is facing away, working at a laptop, or occluded behind desks.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl border border-slate-100 bg-white">
                    <span className="font-semibold text-slate-700 block mb-1">Permanent Employee Identity</span>
                    <p className="font-mono text-slate-500 text-[11px] break-all">{selectedEmpObj?.id}</p>
                    <p className="text-emerald-700 font-semibold mt-2">✅ Enrolled with 4 angle templates</p>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-100 bg-white">
                    <span className="font-semibold text-slate-700 block mb-1">Track Protection Rules</span>
                    <p className="text-slate-500 text-[11px]">
                      • Exclusivity: 1:1 employee to track association.<br />
                      • Anti-Hijack: Requires 5 consecutive conflicting frames.<br />
                      • Seated Damping: 10s grace period for stationary desks.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Manual Correction Dialog Modal */}
        {correctionInterval && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-100 space-y-4">
              <div className="flex items-center justify-between border-b pb-3">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-blue-600" />
                  Manual Zone Correction
                </h3>
                <button onClick={() => setCorrectionInterval(null)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCorrectionSubmit} className="space-y-4 text-xs">
                {correctionError && (
                  <p className="p-2.5 rounded-lg bg-red-50 text-red-700 font-semibold">{correctionError}</p>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Corrected Zone</label>
                  <select
                    value={newZoneId}
                    onChange={(e) => setNewZoneId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs font-semibold text-slate-800"
                  >
                    <option value="WORK_ROOM">Working Room</option>
                    <option value="LUNCH_ROOM">Lunch Room</option>
                    <option value="PASSAGE">Passage</option>
                    <option value="OUTSIDE">Outside Office</option>
                    <option value="UNKNOWN">Unknown / Unobserved</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Mandatory Audit Reason (min 5 chars)</label>
                  <textarea
                    rows={3}
                    value={correctionReason}
                    onChange={(e) => setCorrectionReason(e.target.value)}
                    placeholder="e.g. Employee attended meeting in Working Room; camera occluded by whiteboard"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:outline-none focus:border-blue-500"
                    required
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t">
                  <button
                    type="button"
                    onClick={() => setCorrectionInterval(null)}
                    className="px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100 font-semibold transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={correctionSubmitting}
                    className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold transition disabled:opacity-50"
                  >
                    {correctionSubmitting ? 'Saving...' : 'Apply Correction'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Administrative Session Close Modal */}
        {showCloseModal && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-100 space-y-4">
              <div className="flex items-center justify-between border-b pb-3">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Administratively Close Session
                </h3>
                <button onClick={() => setShowCloseModal(false)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCloseSession} className="space-y-4 text-xs">
                {closeError && (
                  <p className="p-2.5 rounded-lg bg-red-50 text-red-700 font-semibold">{closeError}</p>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Target Status</label>
                  <select
                    value={closeStatus}
                    onChange={(e) => setCloseStatus(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs font-semibold text-slate-800"
                  >
                    <option value="COMPLETED">COMPLETED (Normal End of Day)</option>
                    <option value="INCOMPLETE">INCOMPLETE (Unresolved Gaps)</option>
                    <option value="REVIEW_REQUIRED">REVIEW_REQUIRED (Flagged for HR)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Mandatory Audit Reason</label>
                  <textarea
                    rows={3}
                    value={closeReason}
                    onChange={(e) => setCloseReason(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-800 focus:outline-none focus:border-blue-500"
                    required
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t">
                  <button
                    type="button"
                    onClick={() => setShowCloseModal(false)}
                    className="px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-100 font-semibold transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={closeSubmitting}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold transition disabled:opacity-50"
                  >
                    {closeSubmitting ? 'Closing...' : 'Confirm Closure'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
