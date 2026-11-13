'use client';

import React, { useEffect, useState } from 'react';
import { BarChart3, Layers, Users, TrendingUp, AlertCircle, ShieldAlert } from 'lucide-react';
import { Header } from '@/components/Header';
import { api } from '@/lib/api';

export default function AnalyticsPage() {
  const [zones, setZones] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOccupancy = async () => {
      try {
        setLoading(true);
        const res = await api.getZoneOccupancy();
        if (res.success && res.data) {
          setZones(res.data);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchOccupancy();
  }, []);

  return (
    <>
      <Header
        title="Workplace Occupancy & Space Analytics"
        subtitle="AI-driven anonymous zone presence, capacity thresholds, and spatial utilization"
      />

      <main className="p-8 space-y-6">
        <div className="bg-white p-6 rounded-xl border border-slate-200/80 shadow-sm space-y-2">
          <div className="flex items-center gap-2 text-slate-800 font-bold text-sm">
            <ShieldAlert className="w-4 h-4 text-blue-600" />
            <span>Privacy-Preserving Workplace Analytics Notice</span>
          </div>
          <p className="text-xs text-slate-500 max-w-3xl leading-relaxed">
            In compliance with strict workplace privacy standards, occupancy analytics are derived entirely from anonymous, non-biometric person detection counts within configured zones. Physical movement and dwell durations are monitored solely for safety, space optimization, and seating allocation, and are strictly separated from individual employee performance evaluation.
          </p>
        </div>

        {/* Zones Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {(zones.length > 0
            ? zones
            : [
                { id: '1', name: 'Engineering Workspace', type: 'DEVELOPMENT', capacity: 15, current: 8 },
                { id: '2', name: 'Conference Room Alpha', type: 'MEETING_ROOM', capacity: 8, current: 4 },
                { id: '3', name: 'Executive Reception', type: 'RECEPTION', capacity: 4, current: 1 },
                { id: '4', name: 'Breakout Lounge', type: 'BREAK_AREA', capacity: 6, current: 2 },
              ]
          ).map((z: any) => {
            const count = z.occupancyRecords?.[0]?.personCount ?? z.current ?? 0;
            const pct = Math.min(100, Math.round((count / (z.capacity || 1)) * 100));

            return (
              <div key={z.id} className="bg-white p-6 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                      {z.type || 'GENERAL'}
                    </span>
                    <h4 className="text-base font-bold text-slate-900 mt-0.5">{z.name}</h4>
                  </div>

                  <span className="px-2.5 py-1 rounded-full text-xs font-mono font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                    {count} / {z.capacity} Occupied
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-slate-500 font-medium">
                    <span>Current Utilization</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        pct > 85 ? 'bg-rose-500' : pct > 50 ? 'bg-amber-500' : 'bg-blue-600'
                      }`}
                      style={{ width: `${pct}%` }}
                    ></div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                  <span>Capacity Limit: {z.capacity} persons</span>
                  <span className={pct > 85 ? 'text-rose-600 font-semibold' : 'text-emerald-600 font-semibold'}>
                    {pct > 85 ? 'Near Capacity' : 'Available Space'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}

