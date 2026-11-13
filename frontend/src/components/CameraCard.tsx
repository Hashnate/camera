'use client';

import React from 'react';
import { Cctv, Wifi, WifiOff, Eye, ShieldCheck, MapPin } from 'lucide-react';

interface CameraCardProps {
  camera: {
    id: string;
    name: string;
    model: string;
    serialNumber: string;
    status: string;
    location?: string;
    lastOnlineAt?: string;
    channels?: { channelNo: number; channelName: string; snapshotUrl?: string }[];
  };
  onSelect: (camera: any) => void;
  isSelected?: boolean;
}

export function CameraCard({ camera, onSelect, isSelected }: CameraCardProps) {
  const isOnline = camera.status === 'ONLINE';

  return (
    <div
      onClick={() => onSelect(camera)}
      className={`cursor-pointer rounded-xl border p-4 transition-all duration-200 bg-white shadow-sm hover:shadow-md ${
        isSelected
          ? 'border-blue-600 ring-2 ring-blue-500/20'
          : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-700">
            <Cctv className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-sm font-semibold text-slate-900 leading-tight">{camera.name}</h4>
            <p className="text-xs text-slate-500 mt-0.5">Model: {camera.model}</p>
          </div>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
            isOnline
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-rose-50 text-rose-700 border border-rose-200'
          }`}
        >
          {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {isOnline ? 'Online' : 'Offline'}
        </span>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div className="flex items-center gap-1.5 truncate">
          <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          <span className="truncate">{camera.location || 'Office Main'}</span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-slate-500 text-[11px]">
          <span>S/N:</span>
          <span>{camera.serialNumber}</span>
        </div>
      </div>

      {/* Channels Pill */}
      {camera.channels && camera.channels.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          {camera.channels.map((ch) => (
            <span
              key={ch.channelNo}
              className="text-[10px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded border border-slate-200"
            >
              Ch{ch.channelNo}: {ch.channelNo === 1 ? 'Wide' : 'PT'}
            </span>
          ))}
          <span className="text-[10px] font-medium text-emerald-600 ml-auto flex items-center gap-0.5">
            <ShieldCheck className="w-3 h-3" /> EZVIZ HLS
          </span>
        </div>
      )}

      <button
        onClick={(e) => {
          e.stopPropagation();
          onSelect(camera);
        }}
        className="w-full mt-3.5 flex items-center justify-center gap-2 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-sm transition-colors"
      >
        <Eye className="w-3.5 h-3.5" />
        Watch Live Stream
      </button>
    </div>
  );
}

