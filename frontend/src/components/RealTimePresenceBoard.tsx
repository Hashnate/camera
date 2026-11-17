'use client';

import React, { useEffect, useState } from 'react';
import { Eye, Radio, Camera, ShieldCheck, MapPin, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { api } from '@/lib/api';

interface PresenceItem {
  employeeId: string;
  fullName: string;
  employeeCode: string;
  department: string | null;
  status: 'OBSERVED_RECENTLY' | 'NOT_RECENTLY_OBSERVED' | 'SENSOR_UNAVAILABLE';
  attendanceStatus?: 'CHECKED_IN' | 'CHECKED_OUT' | 'NOT_CHECKED_IN';
  locationUncertainty?: boolean;
  identityVerificationStatus?: string;
  lastObservedAt: string | null;
  trackingFreshnessSec?: number | null;
  lastCameraId: string | null;
  lastChannelNo: number | null;
  sourceCamera?: string | null;
  lastSimilarity: number | null;
  currentZoneId: string | null;
}

function timeAgo(iso: string | null) {
  if (!iso) return 'Never observed today';
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 10) return 'Just now (<10s ago)';
  if (diffSec < 60) return `${diffSec} seconds ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  return `${Math.floor(diffSec / 3600)} hour(s) ago`;
}

export function RealTimePresenceBoard() {
  const [presenceList, setPresenceList] = useState<PresenceItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPresence = async () => {
    try {
      const res = await api.getPresenceOverview();
      if (res.success && res.data) {
        setPresenceList(res.data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPresence();
    const interval = setInterval(fetchPresence, 3000); // 3-second live refresh
    return () => clearInterval(interval);
  }, []);

  const recentlyObserved = presenceList.filter((p) => p.status === 'OBSERVED_RECENTLY');
  const notRecentlyObserved = presenceList.filter((p) => p.status === 'NOT_RECENTLY_OBSERVED');

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 border border-indigo-200">
              System A — Observational Presence
            </span>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live 3s Ingestion
            </span>
          </div>
          <h3 className="text-base font-bold text-slate-900 mt-1">Real-Time Office Presence Monitor</h3>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-emerald-700">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm" />
            <span>{recentlyObserved.length} In Camera View</span>
          </div>
          <div className="flex items-center gap-1.5 font-semibold text-slate-500">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-300" />
            <span>{notRecentlyObserved.length} In Unmonitored Zones</span>
          </div>
        </div>
      </div>

      {/* Employee Cards Grid */}
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {presenceList.map((emp) => {
          const isObserved = emp.status === 'OBSERVED_RECENTLY';

          return (
            <div
              key={emp.employeeId}
              className={`p-4 rounded-xl border transition-all duration-300 ${
                isObserved
                  ? 'border-emerald-300 bg-gradient-to-br from-emerald-50/40 via-white to-emerald-50/10 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <h4 className="text-sm font-bold text-slate-900">
                      {emp.fullName}
                    </h4>
                    {emp.employeeCode === '22IT0512' && (
                      <span className="px-1.5 py-0.2 bg-blue-100 text-blue-700 text-[10px] font-bold rounded">
                        You
                      </span>
                    )}
                    {emp.attendanceStatus === 'CHECKED_IN' ? (
                      <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                        Checked In
                      </span>
                    ) : emp.attendanceStatus === 'CHECKED_OUT' ? (
                      <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
                        Checked Out
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[9px] font-medium bg-slate-100 text-slate-500">
                        Not Checked In
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">{emp.department || 'Engineering'} • {emp.employeeCode}</p>
                </div>

                {isObserved ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-600 text-white shadow-xs shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                    Observed Now
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 shrink-0">
                    <AlertCircle className="w-3 h-3 text-amber-500" />
                    Location Uncertain
                  </span>
                )}
              </div>

              <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5 text-xs text-slate-600">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1 text-[11px]">
                    <Eye className="w-3.5 h-3.5" /> Last Verified Sighting:
                  </span>
                  <span className="font-semibold text-slate-800 text-[11px] font-mono">
                    {timeAgo(emp.lastObservedAt)}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1 text-[11px]">
                    <MapPin className="w-3.5 h-3.5 text-indigo-500" /> Office Zone:
                  </span>
                  <span className={`font-semibold px-2 py-0.5 rounded text-[10px] border ${
                    isObserved
                      ? 'text-indigo-700 bg-indigo-50 border-indigo-200'
                      : 'text-slate-600 bg-slate-50 border-slate-200'
                  }`}>
                    {emp.currentZoneId ? emp.currentZoneId.replace(/_/g, ' ') : (isObserved ? 'Passage' : 'Uncertain (Blind Spot)')}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1 text-[11px]">
                    <Camera className="w-3.5 h-3.5" /> Camera Lens:
                  </span>
                  <span className="font-medium text-slate-700 text-[11px]">
                    {emp.sourceCamera || (emp.lastChannelNo === 1 ? 'Ch 1 (Wide Lens)' : emp.lastChannelNo === 2 ? 'Ch 2 (Pan-Tilt)' : 'No recent stream')}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-400 flex items-center gap-1 text-[11px]">
                    <ShieldCheck className="w-3.5 h-3.5" /> Biometric Identity:
                  </span>
                  <span className={`font-mono font-bold text-[11px] ${
                    emp.identityVerificationStatus === 'VERIFIED' ? 'text-emerald-700' : 'text-slate-500'
                  }`}>
                    {emp.identityVerificationStatus || 'UNVERIFIED'}{' '}
                    {emp.lastSimilarity !== null ? `(${(emp.lastSimilarity * 100).toFixed(1)}%)` : ''}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Uncertainty Notice Footer */}
      <div className="px-6 py-2.5 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-500 flex items-center gap-2">
        <AlertCircle className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span>
          <b>Uncertainty Principle:</b> &quot;Not in View&quot; does <b>not</b> mean you have left the office. It simply means you are in a camera blind spot or meeting room. Face observations never change your official paid hours.
        </span>
      </div>
    </div>
  );
}
