'use client';

import React, { useEffect, useState, useCallback } from 'react';
import {
  Cctv,
  RefreshCw,
  Plus,
  Wifi,
  ShieldCheck,
  Video,
  AlertCircle,
  Layers,
  Info,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { CameraCard } from '@/components/CameraCard';
import { VideoPlayer } from '@/components/VideoPlayer';
import { api } from '@/lib/api';

export default function CamerasPage() {
  const [cameras, setCameras] = useState<any[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const fetchCameras = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.getCameras();
      if (res.success && res.data) {
        setCameras(res.data);
        if (res.data.length > 0 && !selectedCamera) {
          setSelectedCamera(res.data[0]);
        }
      }
    } catch (err: any) {
      console.error('Error fetching cameras:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedCamera]);

  useEffect(() => {
    fetchCameras();
  }, [fetchCameras]);

  const handleSyncEZVIZ = async () => {
    try {
      setSyncing(true);
      setSyncMessage(null);
      const res = await api.syncEZVIZ();
      if (res.success) {
        setSyncMessage(`Synced ${res.data?.length || 0} device(s) with official EZVIZ Open Platform`);
        await fetchCameras();
      }
    } catch (err: any) {
      setSyncMessage(`Sync error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <Header
        title="Live Camera Monitoring & Management"
        subtitle="Manage IP cameras, inspect stream health, and monitor multi-lens live video feeds"
      />

      <main className="p-8 space-y-8">
        {/* Actions Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
          <div>
            <h2 className="text-base font-bold text-slate-900">Connected Workplace Cameras</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Integrated with official EZVIZ Open Platform API (<span className="font-mono text-slate-700">open.ezvizlife.com</span>)
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleSyncEZVIZ}
              disabled={syncing}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold border border-slate-300 disabled:opacity-60 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Syncing with EZVIZ...' : 'Sync EZVIZ Platform'}</span>
            </button>
          </div>
        </div>

        {/* Sync notification message */}
        {syncMessage && (
          <div className="p-3.5 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-between text-xs text-blue-700">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-600 flex-shrink-0" />
              <span>{syncMessage}</span>
            </div>
            <button
              onClick={() => setSyncMessage(null)}
              className="text-blue-500 hover:text-blue-800 text-xs font-medium"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Main Content Layout: Live Player on Top / Left, Camera Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          {/* Active Live Video Player (2 Columns) */}
          <div className="lg:col-span-2 space-y-4">
            {selectedCamera ? (
              <div className="space-y-4">
                <VideoPlayer
                  key={selectedCamera.id}
                  cameraId={selectedCamera.id}
                  serialNumber={selectedCamera.serialNumber}
                  cameraName={selectedCamera.name}
                  channels={selectedCamera.channels}
                />

                {/* Camera Hardware Specs Card */}
                <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Info className="w-4 h-4 text-slate-500" />
                      Hardware & Integration Specifications
                    </h4>
                    <span className="text-xs font-medium text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                      Verified Hardware
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                    <div>
                      <p className="text-slate-400 font-medium">Device Brand</p>
                      <p className="text-slate-800 font-semibold mt-0.5">EZVIZ</p>
                    </div>
                    <div>
                      <p className="text-slate-400 font-medium">Model Variant</p>
                      <p className="text-slate-800 font-semibold mt-0.5">{selectedCamera.model || 'CS-H7c'}</p>
                    </div>
                    <div>
                      <p className="text-slate-400 font-medium">Serial Number</p>
                      <p className="text-slate-800 font-mono font-semibold mt-0.5">{selectedCamera.serialNumber}</p>
                    </div>
                    <div>
                      <p className="text-slate-400 font-medium">Firmware</p>
                      <p className="text-slate-800 font-semibold mt-0.5">{selectedCamera.firmwareVer || 'V5.3.8 build 250812'}</p>
                    </div>
                  </div>

                  <div className="pt-2 text-xs text-slate-500 bg-slate-50 p-3 rounded-lg border border-slate-200/60">
                    <p className="font-semibold text-slate-700 mb-1">Dual-Lens Architecture:</p>
                    <ul className="list-disc list-inside space-y-0.5 text-slate-600">
                      <li><strong>Channel 1 (Hashnate -WL)</strong>: Static 2.8mm wide-angle lens for full room surveillance and zone boundary tracking.</li>
                      <li><strong>Channel 2 (Hashnate -PT)</strong>: Motorized Pan-Tilt lens for focal tracking and high-detail observation.</li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-500">
                <Cctv className="w-12 h-12 mx-auto text-slate-400 mb-3" />
                <p className="text-sm font-medium">No camera selected</p>
                <p className="text-xs text-slate-400 mt-1">Select a camera from the list to launch the live video feed</p>
              </div>
            )}
          </div>

          {/* Camera Selection List (1 Column) */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Cctv className="w-4 h-4 text-slate-500" />
                Registered Devices ({cameras.length})
              </h3>
              <span className="text-xs text-slate-400">Click to switch stream</span>
            </div>

            {loading ? (
              <div className="p-8 text-center bg-white rounded-xl border border-slate-200">
                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                <p className="text-xs text-slate-500">Loading registered cameras...</p>
              </div>
            ) : cameras.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-xl border border-slate-200">
                <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                <p className="text-xs font-semibold text-slate-700">No cameras registered</p>
                <p className="text-[11px] text-slate-500 mt-1 mb-3">Sync with EZVIZ Open Platform to fetch your H7c camera</p>
                <button
                  onClick={handleSyncEZVIZ}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold"
                >
                  Sync EZVIZ Now
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {cameras.map((cam) => (
                  <CameraCard
                    key={cam.id}
                    camera={cam}
                    onSelect={(c) => setSelectedCamera(c)}
                    isSelected={selectedCamera?.id === cam.id}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

