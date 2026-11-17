'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Coffee,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Calendar,
  RefreshCw,
  Plus,
  ShieldCheck,
  MapPin,
  TrendingUp,
  FileText,
  UserCheck,
  ChevronRight,
  ExternalLink,
  Edit2,
  Trash2,
  Sliders,
  DollarSign,
  AlertCircle,
  HelpCircle,
  X,
  StopCircle,
} from 'lucide-react';
import {
  breaksApi,
  LiveBreakEmployee,
  BreakPolicyItem,
  BreakIntervalItem,
  BreakReconciliationItem,
  api,
} from '@/lib/api';

export default function BreaksDashboardPage() {
  const [activeTab, setActiveTab] = useState<'live' | 'ledger' | 'reconciliation' | 'policies'>('policies');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Selected date filter (YYYY-MM-DD)
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const now = new Date();
    return now.toISOString().split('T')[0];
  });

  // Data states
  const [liveEmployees, setLiveEmployees] = useState<LiveBreakEmployee[]>([]);
  const [policies, setPolicies] = useState<BreakPolicyItem[]>([]);
  const [ledger, setLedger] = useState<BreakIntervalItem[]>([]);
  const [reconciliation, setReconciliation] = useState<BreakReconciliationItem[]>([]);
  const [allEmployees, setAllEmployees] = useState<any[]>([]);
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  // Modals
  const [showDeclareModal, setShowDeclareModal] = useState(false);
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [showCorrectModal, setShowCorrectModal] = useState(false);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState<{
    type: 'policy' | 'interval';
    id: string;
    title: string;
    description: string;
  } | null>(null);

  const [selectedInterval, setSelectedInterval] = useState<BreakIntervalItem | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<BreakPolicyItem | null>(null);

  // Form states
  const [declareForm, setDeclareForm] = useState({
    employee_id: '',
    break_type: 'PRAYER',
    duration_minutes: 15,
    notes: '',
  });

  const [correctForm, setCorrectForm] = useState({
    new_duration_seconds: 0,
    new_classification: 'APPROVED_LUNCH',
    reason: '',
  });

  const [policyForm, setPolicyForm] = useState<{
    id?: string;
    breakType: string;
    name: string;
    allowedDurationMinutes: number;
    isPaid: boolean;
    maxCountPerDay: number;
    notes: string;
    employeeId: string;
  }>({
    breakType: 'LUNCH',
    name: 'Lunch Allowance',
    allowedDurationMinutes: 60,
    isPaid: false,
    maxCountPerDay: 1,
    notes: '',
    employeeId: '',
  });

  // Client-side live clock
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Auto-dismiss status messages after 5 seconds
  useEffect(() => {
    if (statusMessage) {
      const timer = setTimeout(() => setStatusMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [statusMessage]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [liveRes, polRes, histRes, recRes, empRes] = await Promise.all([
        breaksApi.getLive(selectedDate),
        breaksApi.getPolicies(),
        breaksApi.getHistory(selectedDate),
        breaksApi.getReconciliation(selectedDate),
        api.getEmployees().catch(() => ({ success: false, data: [] })),
      ]);

      if (liveRes.success) setLiveEmployees(liveRes.data);
      if (polRes.success) setPolicies(polRes.data);
      if (histRes.success) setLedger(histRes.data);
      if (recRes.success) setReconciliation(recRes.data);
      if (empRes.success && empRes.data) setAllEmployees(empRes.data);
    } catch (err: any) {
      console.error('Failed to load break data:', err);
      setStatusMessage({ type: 'error', text: err.message || 'Failed to communicate with Break Engine service' });
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Open Policy Modal for Creating New
  const handleOpenNewPolicy = () => {
    setEditingPolicy(null);
    setPolicyForm({
      breakType: 'LUNCH',
      name: 'Custom Break Allowance',
      allowedDurationMinutes: 30,
      isPaid: false,
      maxCountPerDay: 1,
      notes: '',
      employeeId: '',
    });
    setShowPolicyModal(true);
  };

  // Open Policy Modal for Editing
  const handleOpenEditPolicy = (p: BreakPolicyItem) => {
    setEditingPolicy(p);
    setPolicyForm({
      id: p.id,
      breakType: p.breakType,
      name: p.name,
      allowedDurationMinutes: p.allowedDurationMinutes,
      isPaid: p.isPaid,
      maxCountPerDay: p.maxCountPerDay || 1,
      notes: p.notes || '',
      employeeId: p.employeeId || '',
    });
    setShowPolicyModal(true);
  };

  // Handle Policy Upsert Submit
  const handlePolicySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setActionLoading(true);
      await breaksApi.upsertPolicy({
        id: editingPolicy?.id,
        breakType: policyForm.breakType,
        name: policyForm.name,
        allowedDurationMinutes: Number(policyForm.allowedDurationMinutes),
        isPaid: Boolean(policyForm.isPaid),
        maxCountPerDay: Number(policyForm.maxCountPerDay || 1),
        notes: policyForm.notes,
        employeeId: policyForm.employeeId || null,
      });

      setShowPolicyModal(false);
      setEditingPolicy(null);
      setStatusMessage({
        type: 'success',
        text: `Policy '${policyForm.name}' saved successfully.`,
      });
      fetchData();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to save policy' });
    } finally {
      setActionLoading(false);
    }
  };

  // Handle Delete Policy
  const handleDeletePolicy = async (policyId: string) => {
    try {
      setActionLoading(true);
      await breaksApi.deletePolicy(policyId);
      setShowDeleteConfirmModal(null);
      setStatusMessage({ type: 'success', text: 'Break policy deleted successfully.' });
      fetchData();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to delete policy' });
    } finally {
      setActionLoading(false);
    }
  };

  // Handle Restore Default Policies
  const handleRestoreDefaults = async () => {
    try {
      setActionLoading(true);
      await breaksApi.restoreDefaults();
      setStatusMessage({ type: 'success', text: 'Standard default break allowances restored successfully.' });
      fetchData();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to restore default policies' });
    } finally {
      setActionLoading(false);
    }
  };

  // Handle Delete Break Interval
  const handleDeleteInterval = async (intervalId: string) => {
    try {
      setActionLoading(true);
      await breaksApi.deleteInterval(intervalId);
      setShowDeleteConfirmModal(null);
      setStatusMessage({ type: 'success', text: 'Break interval record deleted successfully.' });
      fetchData();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to delete break interval' });
    } finally {
      setActionLoading(false);
    }
  };

  // Handle End Active Ongoing Break
  const handleEndOngoingBreak = async (intervalId: string) => {
    try {
      setActionLoading(true);
      await breaksApi.endOngoingBreak(intervalId);
      setStatusMessage({ type: 'success', text: 'Active break interval ended and calculated successfully.' });
      fetchData();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to end ongoing break' });
    } finally {
      setActionLoading(false);
    }
  };

  // Handle Declare Break Submit
  const handleDeclareSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!declareForm.employee_id) {
      setStatusMessage({ type: 'error', text: 'Please select an employee' });
      return;
    }
    try {
      setActionLoading(true);
      await breaksApi.declareBreak({
        employee_id: declareForm.employee_id,
        break_type: declareForm.break_type,
        duration_minutes: Number(declareForm.duration_minutes),
        notes: declareForm.notes,
      });
      setShowDeclareModal(false);
      setDeclareForm({ employee_id: '', break_type: 'PRAYER', duration_minutes: 15, notes: '' });
      setStatusMessage({ type: 'success', text: 'Authorized break declared successfully.' });
      fetchData();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to declare break' });
    } finally {
      setActionLoading(false);
    }
  };

  // Handle Admin Correction Submit
  const handleCorrectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedInterval) return;
    if (!correctForm.reason || correctForm.reason.trim().length < 5) {
      setStatusMessage({ type: 'error', text: 'Please provide a mandatory audit explanation (minimum 5 characters).' });
      return;
    }
    try {
      setActionLoading(true);
      await breaksApi.correctInterval(selectedInterval.id, {
        new_duration_seconds: Number(correctForm.new_duration_seconds),
        new_classification: correctForm.new_classification,
        reason: correctForm.reason,
      });
      setShowCorrectModal(false);
      setSelectedInterval(null);
      setStatusMessage({ type: 'success', text: 'Break interval corrected and logged to audit trail.' });
      fetchData();
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to correct interval' });
    } finally {
      setActionLoading(false);
    }
  };

  // Helper for available employees in dropdown
  const availableEmployees = allEmployees.length > 0
    ? allEmployees
    : liveEmployees.map(e => ({ id: e.employeeId, fullName: e.employeeName, employeeCode: e.employeeCode }));

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Status Toast Message */}
      {statusMessage && (
        <div
          className={`p-4 rounded-xl border flex items-center justify-between shadow-md transition-all ${
            statusMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-rose-600 flex-shrink-0" />
            )}
            <span className="text-sm font-medium">{statusMessage.text}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="p-1 hover:bg-slate-200/50 rounded-lg text-slate-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center font-bold">
              <Coffee className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-slate-900">Actual Movement-Based Break Engine</h1>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                  v2.8 Active
                </span>
              </div>
              <p className="text-sm text-slate-500">
                Doorway transition tracking, non-overlapping intervals, zero double-counting reconciliation
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowDeclareModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Declare Break
          </button>
          <button
            onClick={() => setActiveTab('policies')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border font-medium text-sm transition-colors ${
              activeTab === 'policies'
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'border-slate-200 hover:bg-slate-50 text-slate-700'
            }`}
          >
            <Sliders className="w-4 h-4 text-slate-500" />
            Policy Settings
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
            title="Refresh All Data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-blue-600' : ''}`} />
          </button>
        </div>
      </div>

      {/* Date Filter & Tab Switcher Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-2">
        <div className="flex items-center gap-6 overflow-x-auto">
          <button
            onClick={() => setActiveTab('live')}
            className={`pb-3 text-sm font-semibold transition-colors relative flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'live' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Clock className="w-4 h-4" />
            Live Break & Away Timers
            {activeTab === 'live' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('ledger')}
            className={`pb-3 text-sm font-semibold transition-colors relative flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'ledger' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <FileText className="w-4 h-4" />
            Today's Break Ledger
            <span className="ml-1 px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-600 font-bold">
              {ledger.length}
            </span>
            {activeTab === 'ledger' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('reconciliation')}
            className={`pb-3 text-sm font-semibold transition-colors relative flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'reconciliation' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <TrendingUp className="w-4 h-4" />
            End-of-Day Reconciliation
            {activeTab === 'reconciliation' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('policies')}
            className={`pb-3 text-sm font-semibold transition-colors relative flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'policies' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            Configured Allowances
            <span className="ml-1 px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-600 font-bold">
              {policies.length}
            </span>
            {activeTab === 'policies' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
        </div>

        {/* Date Selector */}
        <div className="flex items-center gap-2 pb-2">
          <Calendar className="w-4 h-4 text-slate-400" />
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="px-2.5 py-1 text-xs border border-slate-300 rounded-lg text-slate-700 bg-white shadow-sm focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={() => setSelectedDate(new Date().toISOString().split('T')[0])}
            className="px-2 py-1 text-xs font-semibold text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded"
          >
            Today
          </button>
        </div>
      </div>

      {/* ============================================================== */}
      {/* TAB 1: LIVE TIMERS */}
      {/* ============================================================== */}
      {activeTab === 'live' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {liveEmployees.length === 0 ? (
              <div className="col-span-full py-12 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
                No active employee tracking sessions observed for {selectedDate}.
              </div>
            ) : (
              liveEmployees.map((emp) => {
                const b = emp.activeBreak;
                let liveElapsedSec = b ? b.elapsedSeconds : 0;
                if (b) {
                  const startMs = new Date(b.startedAt).getTime();
                  const nowMs = currentTime.getTime();
                  liveElapsedSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
                }
                const allowedSec = b ? b.allowedDurationMinutes * 60 : 0;
                const isExceeded = b ? liveElapsedSec > allowedSec : false;
                const remainingSec = b ? Math.max(0, allowedSec - liveElapsedSec) : 0;
                const excessSec = b ? Math.max(0, liveElapsedSec - allowedSec) : 0;
                const progressPct = allowedSec > 0 ? Math.min(100, (liveElapsedSec / allowedSec) * 100) : 0;

                const formatSec = (sec: number) => {
                  const m = Math.floor(sec / 60);
                  const s = sec % 60;
                  return `${m}m ${s < 10 ? '0' : ''}${s}s`;
                };

                return (
                  <div
                    key={emp.employeeId}
                    className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-5 hover:shadow-md transition-shadow"
                  >
                    {/* Top: Employee Info */}
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-slate-900 text-base">{emp.employeeName}</h3>
                          <span className="text-xs px-2 py-0.5 font-semibold bg-slate-100 text-slate-600 rounded">
                            {emp.employeeCode}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {emp.jobTitle} • {emp.departmentName}
                        </p>
                      </div>

                      {/* Zone Badge */}
                      <span
                        className={`text-xs px-2.5 py-1 rounded-full font-semibold flex items-center gap-1.5 ${
                          emp.currentZoneId === 'WORK_ROOM'
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : emp.currentZoneId === 'LUNCH_ROOM'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200'
                            : emp.currentZoneId === 'OUTSIDE'
                            ? 'bg-purple-50 text-purple-700 border border-purple-200'
                            : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}
                      >
                        <MapPin className="w-3 h-3" />
                        {emp.currentZoneId.replace('_', ' ')}
                      </span>
                    </div>

                    {/* Active Break State Card */}
                    {b ? (
                      <div
                        className={`p-4 rounded-xl border space-y-3 ${
                          isExceeded
                            ? 'bg-rose-50/70 border-rose-200 text-rose-900'
                            : 'bg-amber-50/60 border-amber-200 text-amber-900'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
                            <Coffee className="w-4 h-4" />
                            {b.breakType} BREAK ({b.allowedDurationMinutes}m allowed)
                          </span>
                          <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                              isExceeded ? 'bg-rose-200 text-rose-800' : 'bg-amber-200 text-amber-800'
                            }`}
                          >
                            {isExceeded ? 'EXCEEDED' : 'ACTIVE'}
                          </span>
                        </div>

                        {/* Live Counter Display */}
                        <div className="flex items-baseline justify-between">
                          <div>
                            <span className="text-xs text-slate-500 block">Actual Elapsed</span>
                            <span className="text-2xl font-black tracking-tight">{formatSec(liveElapsedSec)}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-xs text-slate-500 block">
                              {isExceeded ? 'Excess Duration' : 'Remaining'}
                            </span>
                            <span
                              className={`text-lg font-bold ${
                                isExceeded ? 'text-rose-600' : 'text-emerald-600'
                              }`}
                            >
                              {isExceeded ? `+${formatSec(excessSec)}` : formatSec(remainingSec)}
                            </span>
                          </div>
                        </div>

                        {/* Progress bar */}
                        <div className="w-full bg-slate-200/80 rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-2 rounded-full transition-all duration-500 ${
                              isExceeded ? 'bg-rose-500' : 'bg-amber-500'
                            }`}
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>

                        {/* Stop/End Break Quick Action */}
                        <div className="pt-2 flex items-center justify-end">
                          <button
                            onClick={() => handleEndOngoingBreak(b.id)}
                            disabled={actionLoading}
                            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
                          >
                            <StopCircle className="w-3.5 h-3.5" />
                            End Break Now
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-slate-500 text-sm">
                        <span className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          No Active Break (Working)
                        </span>
                        <span className="text-xs text-slate-400">All allowances ready</span>
                      </div>
                    )}

                    {/* Summary Bar */}
                    <div className="pt-2 border-t border-slate-100 grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="bg-slate-50 p-2 rounded-lg">
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Lunch</span>
                        <span className="font-semibold text-slate-700">
                          {emp.todayBreaksSummary.lunchApprovedFormatted}
                          {emp.todayBreaksSummary.lunchExcessSeconds > 0 && (
                            <span className="text-rose-600 ml-1">
                              (+{emp.todayBreaksSummary.lunchExcessFormatted})
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="bg-slate-50 p-2 rounded-lg">
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Prayer / Tea</span>
                        <span className="font-semibold text-slate-700">
                          {emp.todayBreaksSummary.prayerFormatted} / {emp.todayBreaksSummary.teaFormatted}
                        </span>
                      </div>
                      <div className="bg-slate-50 p-2 rounded-lg">
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Outside</span>
                        <span className="font-semibold text-slate-700">
                          {emp.todayBreaksSummary.outsideFormatted}
                        </span>
                      </div>
                    </div>

                    {/* Freshness & Last verified movement */}
                    <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1">
                      <span>
                        Sensor:{' '}
                        <span
                          className={`font-semibold ${
                            emp.currentObservationStatus === 'OBSERVED_RECENTLY'
                              ? 'text-emerald-600'
                              : 'text-amber-600'
                          }`}
                        >
                          {emp.currentObservationStatus}
                        </span>
                      </span>
                      {emp.lastMovement && (
                        <span title={emp.lastMovement.timestamp}>
                          Last: {emp.lastMovement.eventType.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* TAB 2: BREAK LEDGER */}
      {/* ============================================================== */}
      {activeTab === 'ledger' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h3 className="font-bold text-slate-900 text-lg">Break & Movement Intervals Ledger</h3>
              <p className="text-sm text-slate-500">
                Audited doorway transitions and manual declarations for date {selectedDate}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50/80 text-xs uppercase font-bold text-slate-500 tracking-wider border-b border-slate-200">
                <tr>
                  <th className="py-3.5 px-6">Employee</th>
                  <th className="py-3.5 px-6">Break Type</th>
                  <th className="py-3.5 px-6">Started At</th>
                  <th className="py-3.5 px-6">Duration</th>
                  <th className="py-3.5 px-6">Allowance & Excess</th>
                  <th className="py-3.5 px-6">Classification</th>
                  <th className="py-3.5 px-6">Source</th>
                  <th className="py-3.5 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ledger.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400">
                      No break intervals recorded for {selectedDate}.
                    </td>
                  </tr>
                ) : (
                  ledger.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50/60 transition-colors">
                      <td className="py-4 px-6">
                        <div className="font-semibold text-slate-900">{item.employeeName}</div>
                        <div className="text-xs text-slate-400">{item.employeeCode}</div>
                      </td>
                      <td className="py-4 px-6">
                        <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
                          <Coffee className="w-3.5 h-3.5 text-amber-500" />
                          {item.breakType}
                        </span>
                        <span className="block text-[11px] text-slate-400">
                          {item.isPaid ? 'Paid' : 'Unpaid'}
                        </span>
                      </td>
                      <td className="py-4 px-6 font-mono text-xs text-slate-600">
                        {new Date(item.startedAt).toLocaleTimeString()}
                      </td>
                      <td className="py-4 px-6">
                        <span className="font-bold text-slate-900">{item.durationFormatted}</span>
                        {item.isOngoing && (
                          <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold animate-pulse">
                            Ongoing
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-6">
                        <span className="text-xs text-slate-500">Allowed: {item.allowedDurationMinutes}m</span>
                        {item.excessDurationSeconds > 0 && (
                          <span className="block text-xs font-bold text-rose-600">
                            Excess: +{item.excessDurationFormatted}
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-6">
                        <span
                          className={`text-xs px-2.5 py-1 rounded-full font-semibold ${
                            item.classification === 'APPROVED_LUNCH' || item.classification === 'APPROVED_BREAK'
                              ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                              : item.classification === 'BREAK_ALLOWANCE_EXCEEDED'
                              ? 'bg-rose-100 text-rose-700 border border-rose-200'
                              : 'bg-slate-100 text-slate-700 border border-slate-200'
                          }`}
                        >
                          {item.classification.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-4 px-6 text-xs text-slate-500">
                        {item.source === 'CAMERA_DOORWAY_CROSSING' ? 'Camera Doorway' : 'Declaration'}
                      </td>
                      <td className="py-4 px-6 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => {
                              setSelectedInterval(item);
                              setCorrectForm({
                                new_duration_seconds: item.durationSeconds,
                                new_classification: item.classification,
                                reason: '',
                              });
                              setShowCorrectModal(true);
                            }}
                            className="px-2.5 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors border border-blue-200"
                          >
                            Correct
                          </button>
                          <button
                            onClick={() =>
                              setShowDeleteConfirmModal({
                                type: 'interval',
                                id: item.id,
                                title: 'Delete Break Interval',
                                description: `Are you sure you want to delete this ${item.breakType} break record (${item.durationFormatted}) for ${item.employeeName}?`,
                              })
                            }
                            className="p-1 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors border border-rose-200"
                            title="Delete Interval"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* TAB 3: END-OF-DAY RECONCILIATION */}
      {/* ============================================================== */}
      {activeTab === 'reconciliation' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-lg">Mutually Exclusive Time Reconciliation</h3>
                <p className="text-sm text-slate-500">
                  Zero double-counting verified for date: {selectedDate}
                </p>
              </div>
              <span className="px-3 py-1 text-xs font-bold rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" />
                Zero Double-Counting Invariant Verified
              </span>
            </div>

            <div className="overflow-x-auto pt-2">
              <table className="w-full text-left text-sm text-slate-600">
                <thead className="bg-slate-50 text-xs uppercase font-bold text-slate-500 tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">Employee</th>
                    <th className="py-3 px-4">Official Att.</th>
                    <th className="py-3 px-4 text-blue-700 bg-blue-50/50">Working Room</th>
                    <th className="py-3 px-4">Approved Lunch</th>
                    <th className="py-3 px-4 text-rose-600">Excess Lunch</th>
                    <th className="py-3 px-4">Prayer</th>
                    <th className="py-3 px-4">Tea</th>
                    <th className="py-3 px-4">Outside</th>
                    <th className="py-3 px-4">Unknown</th>
                    <th className="py-3 px-4 font-bold text-slate-900">Net Productive</th>
                    <th className="py-3 px-4 text-slate-500">Deductible</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reconciliation.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="py-8 text-center text-slate-400">
                        No reconciliation records for {selectedDate}.
                      </td>
                    </tr>
                  ) : (
                    reconciliation.map((rec) => (
                      <tr key={rec.employeeId} className="hover:bg-slate-50/60">
                        <td className="py-4 px-4">
                          <div className="font-semibold text-slate-900">{rec.employeeName}</div>
                          <div className="text-xs text-slate-400">{rec.employeeCode}</div>
                        </td>
                        <td className="py-4 px-4 font-mono text-xs">{rec.officialAttendanceFormatted}</td>
                        <td className="py-4 px-4 font-bold text-blue-700 bg-blue-50/30">
                          {rec.workRoomFormatted}
                        </td>
                        <td className="py-4 px-4">{rec.lunchApprovedFormatted}</td>
                        <td className="py-4 px-4 text-rose-600 font-medium">
                          {rec.lunchExcessSeconds > 0 ? `+${rec.lunchExcessFormatted}` : '0m'}
                        </td>
                        <td className="py-4 px-4">{rec.prayerFormatted}</td>
                        <td className="py-4 px-4">{rec.teaFormatted}</td>
                        <td className="py-4 px-4">{rec.outsideOfficeFormatted}</td>
                        <td className="py-4 px-4 text-slate-400">{rec.unknownFormatted}</td>
                        <td className="py-4 px-4 font-black text-slate-900 text-sm">
                          {rec.netProductiveFormatted}
                        </td>
                        <td className="py-4 px-4 text-xs font-semibold text-slate-500">
                          {rec.totalDeductibleFormatted}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* TAB 4: POLICY SETTINGS (CONFIGURED ALLOWANCES) */}
      {/* ============================================================== */}
      {activeTab === 'policies' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-slate-900 text-lg">Configured Break Allowances</h3>
              <p className="text-sm text-slate-500">
                Customizable allowances for lunch, prayer, tea, outside departure, and personal pauses
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                onClick={handleRestoreDefaults}
                disabled={actionLoading}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 text-slate-600 font-medium text-xs hover:bg-slate-50 transition-colors shadow-2xs"
                title="Restore Standard Default Break Allowances"
              >
                <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                Restore Defaults
              </button>
              <button
                onClick={handleOpenNewPolicy}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white font-medium text-xs hover:bg-blue-700 transition-colors shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Policy
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {policies.map((p) => (
              <div
                key={p.id}
                className="p-5 rounded-xl border border-slate-200/80 space-y-4 hover:border-slate-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-bold text-slate-900">{p.name}</h4>
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      {p.breakType}
                    </span>
                  </div>
                  <span
                    className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                      p.isPaid ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {p.isPaid ? 'PAID' : 'UNPAID'}
                  </span>
                </div>

                <div className="space-y-1">
                  <div className="text-2xl font-black text-slate-900">
                    {p.allowedDurationMinutes} <span className="text-sm font-normal text-slate-500">minutes</span>
                  </div>
                  <p className="text-xs text-slate-500 min-h-[32px]">{p.notes || 'Configured allowance'}</p>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
                  <span>Scope: {p.employeeId ? 'Employee Specific' : 'Company Wide'}</span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleOpenEditPolicy(p)}
                      className="text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1 transition-colors"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      onClick={() =>
                        setShowDeleteConfirmModal({
                          type: 'policy',
                          id: p.id,
                          title: 'Delete Break Policy',
                          description: `Are you sure you want to delete policy '${p.name}' (${p.breakType})? This action cannot be undone.`,
                        })
                      }
                      className="text-rose-600 hover:text-rose-800 font-semibold flex items-center gap-1 transition-colors ml-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* MODAL 1: DECLARE AUTHORIZED BREAK */}
      {/* ============================================================== */}
      {showDeclareModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Declare Authorized Break</h3>
              <button
                onClick={() => setShowDeclareModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              For prayer, tea, or manager-approved pauses that do not rely on facial expression inference.
            </p>

            <form onSubmit={handleDeclareSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Employee *</label>
                <select
                  value={declareForm.employee_id}
                  onChange={(e) => setDeclareForm({ ...declareForm, employee_id: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white"
                  required
                >
                  <option value="">Select an employee...</option>
                  {availableEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.fullName} ({emp.employeeCode})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Break Type</label>
                <select
                  value={declareForm.break_type}
                  onChange={(e) => setDeclareForm({ ...declareForm, break_type: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="PRAYER">Prayer Break (15m paid)</option>
                  <option value="TEA">Tea Break (10m paid)</option>
                  <option value="PERSONAL">Personal Break (15m unpaid)</option>
                  <option value="LUNCH">Lunch Break (60m unpaid)</option>
                  <option value="OTHER">Other Approved Break</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Duration (Minutes) *
                </label>
                <input
                  type="number"
                  min="1"
                  max="240"
                  value={declareForm.duration_minutes}
                  onChange={(e) => setDeclareForm({ ...declareForm, duration_minutes: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Notes / Reason</label>
                <input
                  type="text"
                  placeholder="e.g. Afternoon Dhuhr prayer"
                  value={declareForm.notes}
                  onChange={(e) => setDeclareForm({ ...declareForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowDeclareModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm"
                >
                  Confirm Declaration
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* MODAL 2: ADMIN INTERVAL CORRECTION */}
      {/* ============================================================== */}
      {showCorrectModal && selectedInterval && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Administrator Interval Correction</h3>
              <button
                onClick={() => setShowCorrectModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Audit log will permanently record this adjustment, admin ID, and reason.
            </p>

            <form onSubmit={handleCorrectSubmit} className="space-y-4">
              <div>
                <span className="text-xs text-slate-400 block uppercase">Target Interval</span>
                <span className="font-bold text-slate-800">
                  {selectedInterval.employeeName} — {selectedInterval.breakType}
                </span>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Corrected Duration (Seconds) *
                </label>
                <input
                  type="number"
                  min="0"
                  value={correctForm.new_duration_seconds}
                  onChange={(e) =>
                    setCorrectForm({ ...correctForm, new_duration_seconds: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  required
                />
                <span className="text-[11px] text-slate-400 mt-0.5 block">
                  Original duration: {selectedInterval.durationFormatted} ({selectedInterval.durationSeconds}s)
                </span>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Corrected Classification
                </label>
                <select
                  value={correctForm.new_classification}
                  onChange={(e) => setCorrectForm({ ...correctForm, new_classification: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="APPROVED_LUNCH">APPROVED_LUNCH</option>
                  <option value="APPROVED_BREAK">APPROVED_BREAK</option>
                  <option value="BREAK_ALLOWANCE_EXCEEDED">BREAK_ALLOWANCE_EXCEEDED</option>
                  <option value="OUTSIDE_INTERVAL">OUTSIDE_INTERVAL</option>
                  <option value="UNPLANNED_AWAY">UNPLANNED_AWAY</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Mandatory Audit Reason (Min 5 chars) *
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Employee was called into client meeting room"
                  value={correctForm.reason}
                  onChange={(e) => setCorrectForm({ ...correctForm, reason: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowCorrectModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm"
                >
                  Save Correction
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* MODAL 3: POLICY ADD / EDIT */}
      {/* ============================================================== */}
      {showPolicyModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">
                {editingPolicy ? 'Edit Break Policy' : 'New Break Policy'}
              </h3>
              <button
                onClick={() => setShowPolicyModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handlePolicySubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Policy Name *</label>
                <input
                  type="text"
                  value={policyForm.name}
                  onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Break Type</label>
                <select
                  value={policyForm.breakType}
                  onChange={(e) => setPolicyForm({ ...policyForm, breakType: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="LUNCH">LUNCH</option>
                  <option value="PRAYER">PRAYER</option>
                  <option value="TEA">TEA</option>
                  <option value="OUTSIDE">OUTSIDE</option>
                  <option value="PERSONAL">PERSONAL</option>
                  <option value="OTHER">OTHER</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                  Allowed Duration (Minutes) *
                </label>
                <input
                  type="number"
                  min="1"
                  max="480"
                  value={policyForm.allowedDurationMinutes}
                  onChange={(e) =>
                    setPolicyForm({ ...policyForm, allowedDurationMinutes: Number(e.target.value) })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Scope</label>
                <select
                  value={policyForm.employeeId}
                  onChange={(e) => setPolicyForm({ ...policyForm, employeeId: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">Company-Wide Shared Policy</option>
                  {availableEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      Specific: {emp.fullName} ({emp.employeeCode})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <input
                  type="checkbox"
                  id="is_paid_input"
                  checked={policyForm.isPaid}
                  onChange={(e) => setPolicyForm({ ...policyForm, isPaid: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                />
                <label htmlFor="is_paid_input" className="text-sm font-medium text-slate-700 cursor-pointer">
                  Paid Break (Credited to productive working hours)
                </label>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 uppercase mb-1">Notes</label>
                <input
                  type="text"
                  value={policyForm.notes}
                  onChange={(e) => setPolicyForm({ ...policyForm, notes: e.target.value })}
                  placeholder="e.g. Verified doorway transitions"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowPolicyModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm"
                >
                  {editingPolicy ? 'Update Policy' : 'Create Policy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* MODAL 4: DELETE CONFIRMATION DIALOG */}
      {/* ============================================================== */}
      {showDeleteConfirmModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
              <Trash2 className="w-6 h-6" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-lg font-bold text-slate-900">{showDeleteConfirmModal.title}</h3>
              <p className="text-xs text-slate-500">{showDeleteConfirmModal.description}</p>
            </div>

            <div className="flex items-center justify-center gap-3 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowDeleteConfirmModal(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg w-full"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (showDeleteConfirmModal.type === 'policy') {
                    handleDeletePolicy(showDeleteConfirmModal.id);
                  } else {
                    handleDeleteInterval(showDeleteConfirmModal.id);
                  }
                }}
                disabled={actionLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-rose-600 hover:bg-rose-700 rounded-lg w-full shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
