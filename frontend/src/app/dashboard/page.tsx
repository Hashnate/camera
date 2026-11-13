'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Users,
  UserCheck,
  UserX,
  Clock,
  Cctv,
  Activity,
  ArrowUpRight,
  ShieldCheck,
  Video,
  Layers,
  MapPin,
  RefreshCw,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { api } from '@/lib/api';

export default function OverviewPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchOverview = async () => {
    try {
      setLoading(true);
      const res = await api.getOverviewStats();
      if (res.success) {
        setData(res.data);
      }
    } catch (err) {
      console.error('Failed to load overview:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, []);

  const summary = data?.summary || {
    totalEmployees: 5,
    presentCount: 3,
    absentCount: 2,
    lateCount: 1,
    totalCameras: 1,
    onlineCameras: 1,
    offlineCameras: 0,
    totalZones: 4,
    occupiedZonesCount: 3,
  };

  return (
    <>
      <Header
        title="Executive Workplace Overview"
        subtitle="Real-time office presence, zone occupancy, and camera operations"
      />

      <main className="p-8 space-y-8">
        {/* KPI Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* Total Employees */}
          <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Registered Staff</p>
              <h3 className="text-2xl font-bold text-slate-900 mt-1">{summary.totalEmployees}</h3>
              <p className="text-xs text-slate-400 mt-0.5">Active workforce</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
              <Users className="w-6 h-6" />
            </div>
          </div>

          {/* Confirmed Present */}
          <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wider">Confirmed Present</p>
              <h3 className="text-2xl font-bold text-slate-900 mt-1">{summary.presentCount}</h3>
              <p className="text-xs text-emerald-600 mt-0.5 font-medium">
                {Math.round((summary.presentCount / (summary.totalEmployees || 1)) * 100)}% attendance rate
              </p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <UserCheck className="w-6 h-6" />
            </div>
          </div>

          {/* Late Arrivals */}
          <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-amber-600 uppercase tracking-wider">Late Arrivals</p>
              <h3 className="text-2xl font-bold text-slate-900 mt-1">{summary.lateCount}</h3>
              <p className="text-xs text-slate-400 mt-0.5">Exceeded grace threshold</p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
              <Clock className="w-6 h-6" />
            </div>
          </div>

          {/* Connected Cameras */}
          <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wider">Live CCTV / IP Cameras</p>
              <h3 className="text-2xl font-bold text-slate-900 mt-1">
                {summary.onlineCameras} <span className="text-sm font-normal text-slate-400">/ {summary.totalCameras}</span>
              </h3>
              <p className="text-xs text-emerald-600 mt-0.5 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> EZVIZ H7c Streaming
              </p>
            </div>
            <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <Cctv className="w-6 h-6" />
            </div>
          </div>
        </div>

        {/* Live Camera Feed Spotlight & Zone Occupancy Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Live Camera Banner (2 Cols) */}
          <div className="lg:col-span-2 bg-gradient-to-br from-slate-900 to-slate-950 rounded-2xl p-6 text-white border border-slate-800 shadow-lg relative overflow-hidden flex flex-col justify-between">
            <div className="flex items-start justify-between z-10">
              <div>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
                  EZVIZ Smart Dual-Lens Online
                </span>
                <h3 className="text-xl font-bold text-white mt-3">EZVIZ CS-H7c (BC7652775)</h3>
                <p className="text-xs text-slate-400 mt-1 max-w-md">
                  Active monitoring stream configured with Dual Channels: Fixed Wide-Angle Lens & Pan-Tilt Tracking Lens.
                </p>
              </div>

              <Link
                href="/dashboard/cameras"
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-colors"
              >
                <span>Open Live Feed</span>
                <ArrowUpRight className="w-4 h-4" />
              </Link>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-800/80 grid grid-cols-3 gap-4 z-10">
              <div>
                <p className="text-[11px] text-slate-400 font-medium">Channel 1 (WL)</p>
                <p className="text-sm font-semibold text-slate-200">Hashnate -WL</p>
                <span className="text-[10px] text-emerald-400">Fixed Wide Lens</span>
              </div>
              <div>
                <p className="text-[11px] text-slate-400 font-medium">Channel 2 (PT)</p>
                <p className="text-sm font-semibold text-slate-200">Hashnate -PT</p>
                <span className="text-[10px] text-emerald-400">Pan-Tilt Lens</span>
              </div>
              <div>
                <p className="text-[11px] text-slate-400 font-medium">Stream Protocol</p>
                <p className="text-sm font-semibold text-slate-200">HLS (m3u8)</p>
                <span className="text-[10px] text-blue-400">Low-Latency Web</span>
              </div>
            </div>
          </div>

          {/* Office Zones Occupancy Card (1 Col) */}
          <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Layers className="w-4 h-4 text-slate-500" />
                  Office Zones Occupancy
                </h3>
                <span className="text-xs font-semibold text-slate-500">
                  {summary.occupiedZonesCount}/{summary.totalZones} Occupied
                </span>
              </div>

              <div className="mt-4 space-y-3.5">
                {(data?.zones || [
                  { name: 'Engineering Workspace', currentOccupancy: 8, capacity: 15 },
                  { name: 'Conference Room Alpha', currentOccupancy: 4, capacity: 8 },
                  { name: 'Executive Reception', currentOccupancy: 1, capacity: 4 },
                  { name: 'Breakout Lounge', currentOccupancy: 2, capacity: 6 },
                ]).map((zone: any) => {
                  const pct = Math.min(100, Math.round((zone.currentOccupancy / (zone.capacity || 1)) * 100));
                  return (
                    <div key={zone.name} className="space-y-1.5">
                      <div className="flex justify-between text-xs font-medium">
                        <span className="text-slate-700">{zone.name}</span>
                        <span className="text-slate-500 font-mono">
                          {zone.currentOccupancy} / {zone.capacity}
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            pct > 80 ? 'bg-rose-500' : pct > 50 ? 'bg-amber-500' : 'bg-blue-600'
                          }`}
                          style={{ width: `${pct}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <Link
                href="/dashboard/analytics"
                className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center justify-between"
              >
                <span>View Full Occupancy Analytics</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

