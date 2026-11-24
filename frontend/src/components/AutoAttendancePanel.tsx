'use client';

import React, { useEffect, useState } from 'react';
import { ScanFace, LogIn, LogOut, Eye, AlertCircle, Radio } from 'lucide-react';
import { api, RecognitionEvent, RecognitionStatus } from '@/lib/api';

const ACTION_STYLE: Record<string, { label: string; cls: string; Icon: React.ElementType }> = {
  CHECK_IN: { label: 'Checked in', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: LogIn },
  CHECK_OUT: { label: 'Check-out updated', cls: 'bg-blue-50 text-blue-700 border-blue-200', Icon: LogOut },
  SEEN: { label: 'Seen', cls: 'bg-slate-50 text-slate-600 border-slate-200', Icon: Eye },
  IGNORED_INACTIVE: { label: 'Ignored (inactive)', cls: 'bg-slate-50 text-slate-500 border-slate-200', Icon: AlertCircle },
};

const SOURCE_LABEL: Record<string, string> = {
  hls: 'Live stream',
  snapshot: 'Snapshots (fallback)',
  webcam: 'Local webcam (test)',
  file: 'Video file (test)',
  folder: 'Image folder (test)',
};

function ago(iso: string | null | undefined) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Live status of the camera face-recognition worker plus the latest recognitions. */
export function AutoAttendancePanel({ onActivity }: { onActivity?: () => void }) {
  const [status, setStatus] = useState<RecognitionStatus | null>(null);
  const [events, setEvents] = useState<RecognitionEvent[]>([]);
  const [lastSeenId, setLastSeenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, e] = await Promise.all([api.getRecognitionStatus(), api.getRecognitionEvents(12, 'CHECK_IN')]);
        if (!alive) return;
        setStatus(s.data);
        setEvents(e.data);
        const newest = e.data[0]?.id ?? null;
        setLastSeenId((prev) => {
          if (prev !== null && newest !== prev) onActivity?.();
          return newest;
        });
      } catch (err) {
        console.error(err);
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const channels = status?.channels ?? [];
  const healthy = status?.reachable && status.running && channels.some((c) => c.state === 'running' || c.state === 'idle');

  return (
    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScanFace className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-900">Automatic attendance (face recognition)</h3>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
            healthy
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : status === null
                ? 'bg-slate-50 text-slate-500 border-slate-200'
                : 'bg-rose-50 text-rose-700 border-rose-200'
          }`}
        >
          <Radio className="w-3 h-3" />
          {status === null ? 'Checking…' : healthy ? 'Watching cameras' : 'Not running'}
        </span>
      </div>

      <div className="grid md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        {/* Worker status */}
        <div className="md:col-span-2 p-4 space-y-3 text-xs">
          {status && !status.reachable && (
            <p className="text-rose-600 flex gap-1.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              AI service is offline. Start it with <code className="font-mono">python src/main.py</code> in
              ai-service/.
            </p>
          )}
          {status?.lastError && <p className="text-amber-700">{status.lastError}</p>}
          {status?.reachable && (
            <p className="text-slate-600">
              <b>{status.galleryEmployees ?? 0}</b> employee(s) enrolled for recognition
            </p>
          )}
          {channels.map((c) => (
            <div key={`${c.cameraId}-${c.channelNo}`} className="p-3 rounded-lg bg-slate-50 border border-slate-100">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-slate-800 truncate">
                  {c.cameraName} · Ch {c.channelNo}
                </p>
                <span
                  className={`w-2 h-2 rounded-full ${
                    c.state === 'running' ? 'bg-emerald-500' : c.state === 'error' ? 'bg-rose-500' : 'bg-amber-400'
                  }`}
                  title={c.state}
                />
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                {c.state === 'idle' ? 'Idle until someone is enrolled' : c.source ? SOURCE_LABEL[c.source] ?? c.source : c.state} · last frame {ago(c.lastFrameAt)} ·{' '}
                {c.framesProcessed} frames · {c.facesDetected} faces
              </p>
              {c.lastError && c.state === 'error' && (
                <p className="text-[11px] text-rose-600 mt-1 break-words">{c.lastError}</p>
              )}
            </div>
          ))}
        </div>

        {/* Recent recognitions */}
        <div className="md:col-span-3 p-4">
          <p className="text-[11px] font-semibold text-slate-500 uppercase mb-2">Recent arrivals</p>
          {events.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">
              No one recognised yet. Enrol faces on the Employees page.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {events.map((e) => {
                const a = ACTION_STYLE[e.action] ?? ACTION_STYLE.SEEN;
                return (
                  <li key={e.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 truncate">{e.employee?.fullName}</p>
                      <p className="text-[11px] text-slate-400 truncate">
                        {new Date(e.seenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                        {e.camera?.name ?? 'Camera'} ch {e.channelNo} · {Math.round(e.similarity * 100)}% match
                      </p>
                    </div>
                    <span
                      className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${a.cls}`}
                    >
                      <a.Icon className="w-3 h-3" /> {a.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
