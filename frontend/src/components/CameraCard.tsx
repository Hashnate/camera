'use client';

import React from 'react';
import { Cctv, MapPin } from 'lucide-react';

interface CameraCardProps {
  camera: {
    id: string;
    name: string;
    model: string;
    serialNumber: string;
    status: string;
    location?: string | null;
    channels?: { channelNo: number; channelName: string }[];
  };
  onSelect: (camera: CameraCardProps['camera']) => void;
  isSelected?: boolean;
}

/** One camera in the Live Cameras list. Shows only what the camera account reports. */
export function CameraCard({ camera, onSelect, isSelected }: CameraCardProps) {
  const isOnline = camera.status === 'ONLINE';

  return (
    <button
      type="button"
      onClick={() => onSelect(camera)}
      aria-pressed={!!isSelected}
      className={`w-full text-left rounded-2xl bg-white p-4 ring-1 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
        isSelected ? 'ring-2 ring-blue-600 shadow-sm' : 'ring-slate-200/70 hover:shadow-sm'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
            <Cctv className="w-4.5 h-4.5" />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-slate-900 truncate">{camera.name}</p>
            <p className="text-[12px] text-slate-500 truncate">{camera.model}</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${isOnline ? 'text-emerald-700' : 'text-rose-700'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-rose-500'}`} aria-hidden="true" />
          {isOnline ? 'Online' : 'Offline'}
        </span>
      </div>

      {camera.location && (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-slate-600 truncate">
          <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          {camera.location}
        </p>
      )}

      {camera.channels && camera.channels.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {camera.channels.map((ch) => (
            <span key={ch.channelNo} className="text-[11px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md">
              {ch.channelName}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
