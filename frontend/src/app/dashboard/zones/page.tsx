'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  MapPin,
  Maximize2,
  RefreshCw,
  Save,
  RotateCcw,
  ShieldCheck,
  UserCheck,
  AlertCircle,
  Eye,
  Activity,
  Layers,
  ArrowRight,
  MoveRight,
  Radio,
  Clock,
  CheckCircle2,
} from 'lucide-react';
import { Header } from '@/components/Header';
import {
  api,
  CameraZone,
  DoorCrossingLine,
  ZoneConfigResponse,
  ActiveTrack,
  ZoneTransition,
} from '@/lib/api';

const DEFAULT_LINE_COLORS: Record<string, { stroke: string; fill: string; text: string }> = {
  LINE_WORK: { stroke: '#2563eb', fill: 'rgba(37, 99, 235, 0.25)', text: '#1d4ed8' },
  LINE_LUNCH: { stroke: '#d97706', fill: 'rgba(217, 119, 6, 0.25)', text: '#b45309' },
  LINE_EXIT: { stroke: '#dc2626', fill: 'rgba(220, 38, 38, 0.25)', text: '#b91c1c' },
};

const ZONE_COLORS: Record<string, { stroke: string; fill: string; label: string }> = {
  WORK_ROOM: { stroke: '#2563eb', fill: 'rgba(37, 99, 235, 0.18)', label: 'Working Room' },
  LUNCH_ROOM: { stroke: '#d97706', fill: 'rgba(217, 119, 6, 0.18)', label: 'Lunch Room' },
  PASSAGE: { stroke: '#7c3aed', fill: 'rgba(124, 58, 237, 0.12)', label: 'Central Corridor' },
  MAIN_EXIT: { stroke: '#dc2626', fill: 'rgba(220, 38, 38, 0.18)', label: 'Outside Exit' },
};

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

export default function OfficeZonesPage() {
  const [cameras, setCameras] = useState<any[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');
  const [selectedChannel, setSelectedChannel] = useState<number>(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  // Calibration state
  const [zones, setZones] = useState<CameraZone[]>([]);
  const [lines, setLines] = useState<DoorCrossingLine[]>([]);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotTimestamp, setSnapshotTimestamp] = useState<string | null>(null);
  const [autoRefreshSnapshot, setAutoRefreshSnapshot] = useState(true);

  // Real-time tracking data
  const [activeTracks, setActiveTracks] = useState<ActiveTrack[]>([]);
  const [transitions, setTransitions] = useState<ZoneTransition[]>([]);
  const [metrics, setMetrics] = useState<{
    detectedPeople: number;
    activeTracks: number;
    verifiedTracks: number;
    unidentifiedTracks: number;
    fps: number;
  }>({
    detectedPeople: 0,
    activeTracks: 0,
    verifiedTracks: 0,
    unidentifiedTracks: 0,
    fps: 0,
  });
  const [frameInfo, setFrameInfo] = useState<{
    frameId?: number;
    frameTimestamp?: string;
    cameraConnectionStatus?: string;
  }>({ cameraConnectionStatus: 'CONNECTING' });
  const [selectedFilterEmployeeId, setSelectedFilterEmployeeId] = useState<string | null>(null);

  // Display toggles
  const [showZones, setShowZones] = useState(true);
  const [showLines, setShowLines] = useState(true);
  const [showTracks, setShowTracks] = useState(true);
  const [activeTab, setActiveTab] = useState<'lines' | 'zones'>('lines');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // 1. Initial Load: Fetch cameras
  useEffect(() => {
    async function loadCameras() {
      try {
        const res = await api.getCameras();
        if (res.success && res.data.length > 0) {
          setCameras(res.data);
          setSelectedCameraId(res.data[0].id);
        }
      } catch (err) {
        console.error('Failed to load cameras', err);
      } finally {
        setLoading(false);
      }
    }
    loadCameras();
  }, []);

  // 2. Fetch Zone Config & Snapshot when Camera or Channel changes
  const loadConfigAndSnapshot = async (camId: string, ch: number) => {
    if (!camId) return;
    try {
      setLoading(true);
      const configRes = await api.getCameraZoneConfig(camId, ch);
      if (configRes.success && configRes.data) {
        setZones(configRes.data.zones || []);
        setLines(configRes.data.lines || []);
      }
      // Load snapshot
      loadSnapshot(camId, ch);
    } catch (err) {
      console.error('Failed to load camera zone config', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSnapshot = async (camId: string, ch: number) => {
    try {
      setSnapshotLoading(true);
      const snap = await api.captureSnapshot(camId, ch);
      if (snap.success && snap.data?.picUrl) {
        setSnapshotUrl(snap.data.picUrl);
        setSnapshotTimestamp(snap.data.timestamp || new Date().toISOString());
      }
    } catch (err) {
      console.error('Snapshot failed, falling back to placeholder', err);
    } finally {
      setSnapshotLoading(false);
    }
  };

  // Auto-refresh camera frame every 5 seconds to keep visual background in sync with live person tracking
  useEffect(() => {
    if (!autoRefreshSnapshot || !selectedCameraId) return;
    const interval = setInterval(() => {
      loadSnapshot(selectedCameraId, selectedChannel);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefreshSnapshot, selectedCameraId, selectedChannel]);

  useEffect(() => {
    if (selectedCameraId) {
      loadConfigAndSnapshot(selectedCameraId, selectedChannel);
    }
  }, [selectedCameraId, selectedChannel]);

  // 3. Live Poll for Active Tracks and Zone Transitions
  useEffect(() => {
    let isMounted = true;

    async function pollLiveTelemetry() {
      try {
        const [tracksRes, transRes] = await Promise.all([
          api.getActiveTracks(selectedCameraId || undefined, selectedChannel),
          api.getZoneTransitions(40),
        ]);
        if (isMounted) {
          if (tracksRes.success) {
            setActiveTracks(tracksRes.data || []);
            if (tracksRes.metrics) setMetrics(tracksRes.metrics);
            setFrameInfo({
              frameId: tracksRes.frameId,
              frameTimestamp: tracksRes.frameTimestamp,
              cameraConnectionStatus: tracksRes.cameraConnectionStatus || 'LIVE',
            });
          }
          if (transRes.success) setTransitions(transRes.data || []);
        }
      } catch (e) {
        console.error('Telemetry polling error', e);
      }
    }

    pollLiveTelemetry();
    const interval = setInterval(pollLiveTelemetry, 1500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [selectedCameraId, selectedChannel]);

  // 4. Draw Overlay on Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match canvas internal resolution to display resolution
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);

    // Draw Zones
    if (showZones) {
      zones.forEach((z) => {
        if (!z.enabled || !z.normalizedPolygon || z.normalizedPolygon.length < 3) return;
        const color = ZONE_COLORS[z.zoneId] || {
          stroke: '#64748b',
          fill: 'rgba(100, 116, 139, 0.2)',
          label: z.zoneName,
        };

        ctx.beginPath();
        const firstPt = z.normalizedPolygon[0];
        ctx.moveTo(firstPt[0] * width, firstPt[1] * height);

        for (let i = 1; i < z.normalizedPolygon.length; i++) {
          const pt = z.normalizedPolygon[i];
          ctx.lineTo(pt[0] * width, pt[1] * height);
        }
        ctx.closePath();

        ctx.fillStyle = color.fill;
        ctx.fill();
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label at centroid
        let cx = 0;
        let cy = 0;
        z.normalizedPolygon.forEach((p) => {
          cx += p[0];
          cy += p[1];
        });
        cx = (cx / z.normalizedPolygon.length) * width;
        cy = (cy / z.normalizedPolygon.length) * height;

        ctx.font = 'bold 11px system-ui, sans-serif';
        const txtWidth = ctx.measureText(z.zoneName).width;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.fillRect(cx - txtWidth / 2 - 6, cy - 10, txtWidth + 12, 20);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(z.zoneName, cx, cy);
      });
    }

    // Draw Doorway Crossing Lines
    if (showLines) {
      lines.forEach((l) => {
        if (!l.enabled) return;
        const color = DEFAULT_LINE_COLORS[l.lineId] || {
          stroke: '#06b6d4',
          fill: 'rgba(6, 182, 212, 0.25)',
          text: '#0891b2',
        };

        const x1 = l.normalizedStartPoint[0] * width;
        const y1 = l.normalizedStartPoint[1] * height;
        const x2 = l.normalizedEndPoint[0] * width;
        const y2 = l.normalizedEndPoint[1] * height;

        // Line
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 3.5;
        ctx.stroke();

        // Start point (Green node)
        ctx.beginPath();
        ctx.arc(x1, y1, 5, 0, 2 * Math.PI);
        ctx.fillStyle = '#10b981';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // End point (Red node)
        ctx.beginPath();
        ctx.arc(x2, y2, 5, 0, 2 * Math.PI);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Normal vector arrow indicating forward crossing direction
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          const nx = -dy / len;
          const ny = dx / len;
          const arrowLen = 22;
          const ax = mx + nx * arrowLen;
          const ay = my + ny * arrowLen;

          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(ax, ay);
          ctx.strokeStyle = color.stroke;
          ctx.lineWidth = 2;
          ctx.stroke();

          // Arrowhead
          const angle = Math.atan2(ny, nx);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - 8 * Math.cos(angle - Math.PI / 6), ay - 8 * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(ax - 8 * Math.cos(angle + Math.PI / 6), ay - 8 * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fillStyle = color.stroke;
          ctx.fill();
        }

        // Line badge
        ctx.font = 'bold 10px system-ui, sans-serif';
        const label = `${l.lineName} (${l.directionMapping?.forward?.event || 'FORWARD'})`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = color.stroke;
        ctx.fillRect(mx - tw / 2 - 5, my - 22, tw + 10, 18);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, mx, my - 13);
      });
    }

    // Draw Active Tracks
    if (showTracks) {
      activeTracks.forEach((t) => {
        if ((!t.cameraId || t.cameraId === selectedCameraId) && (t.channelNo === undefined || t.channelNo === selectedChannel)) {
          // v2.9 — 5-tier color system based on ILE identity state
          const identityState = (t as any).identityState || t.identityVerificationStatus || 'UNVERIFIED';
          const isVerified = t.identityVerificationStatus === 'VERIFIED' || identityState === 'IDENTITY_LATCHED';
          const color =
            identityState === 'IDENTITY_LATCHED'           ? '#10b981' :  // 🟢 GREEN — face visible, latched
            identityState === 'VERIFIED'                   ? '#10b981' :  // 🟢 GREEN — legacy verified
            identityState === 'TRACKING_WITHOUT_FACE'      ? '#3b82f6' :  // 🔵 BLUE  — back turned, identity held
            identityState === 'TRACKING_UNCERTAIN'         ? '#f97316' :  // 🟠 ORANGE — path crossing
            identityState === 'REQUIRES_REVERIFICATION'    ? '#ef4444' :  // 🔴 RED   — needs re-check
            identityState === 'IDENTITY_CANDIDATE'         ? '#a855f7' :  // 🟣 PURPLE — building confidence
            '#f59e0b';                                                     // 🟡 AMBER  — unidentified

          // State suffix tag for label
          const stateTag =
            identityState === 'TRACKING_WITHOUT_FACE'   ? ' [TWF]' :
            identityState === 'TRACKING_UNCERTAIN'       ? ' [?]'   :
            identityState === 'REQUIRES_REVERIFICATION'  ? ' [!]'   :
            identityState === 'IDENTITY_CANDIDATE'       ? ' [~]'   : '';

          if (t.boundingBox && t.boundingBox.length === 4) {
            const bx = t.boundingBox[0] * width;
            const by = t.boundingBox[1] * height;
            const bw = (t.boundingBox[2] - t.boundingBox[0]) * width;
            const bh = (t.boundingBox[3] - t.boundingBox[1]) * height;

            if (bw > 10 && bh > 10) {
              // Bounding box
              ctx.strokeStyle = color;
              ctx.lineWidth = 2.5;
              ctx.strokeRect(bx, by, bw, bh);

              // Top label pill
              const nameLabel = isVerified ? `${t.employeeName} ✓` : (t.employeeName || 'Unidentified Person');
              const confLabel = t.detectionScore ? ` ${Math.round(t.detectionScore * 100)}%` : '';
              const tag = `Track #${t.trackId}: ${nameLabel}${confLabel}${stateTag}`;
              ctx.font = 'bold 11px system-ui, sans-serif';
              const tw = ctx.measureText(tag).width;
              ctx.fillStyle = color;
              ctx.fillRect(bx, Math.max(0, by - 20), tw + 10, 18);
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(tag, bx + 5, Math.max(9, by - 11));

              // Zone badge below box
              if (t.currentZoneId) {
                const ztag = t.currentZoneId.replace(/_/g, ' ');
                ctx.font = 'bold 9px system-ui, sans-serif';
                const ztw = ctx.measureText(ztag).width;
                ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
                ctx.fillRect(bx, by + bh + 2, ztw + 8, 14);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(ztag, bx + 4, by + bh + 9);
              }
            }
          }
        }
      });
    }
  }, [zones, lines, activeTracks, showZones, showLines, showTracks, selectedCameraId, selectedChannel, snapshotUrl]);

  // Handle Save Calibration
  const handleSaveConfig = async () => {
    try {
      setSaving(true);
      setSaveStatus(null);
      const res = await api.updateCameraZoneConfig(selectedCameraId, selectedChannel, {
        zones,
        lines,
      });
      if (res.success) {
        setSaveStatus('Calibration configuration saved and pushed to live tracking engine!');
        setTimeout(() => setSaveStatus(null), 4000);
      }
    } catch (err: any) {
      setSaveStatus(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // Revert / Reset to approved baseline coordinates
  const handleResetToApproved = () => {
    if (selectedChannel === 1) {
      setLines([
        {
          id: 'line_lunch',
          cameraId: selectedCameraId,
          channelNo: 1,
          lineId: 'LINE_LUNCH',
          lineName: 'Lunch Room Boundary',
          normalizedStartPoint: [0.37, 0.606],
          normalizedEndPoint: [0.266, 0.593],
          directionMapping: {
            forward: { event: 'LUNCH_ROOM_ENTERED', from: 'PASSAGE', to: 'LUNCH_ROOM' },
            backward: { event: 'LUNCH_ROOM_EXITED', from: 'LUNCH_ROOM', to: 'PASSAGE' },
          },
          enabled: true,
        },
        {
          id: 'line_work',
          cameraId: selectedCameraId,
          channelNo: 1,
          lineId: 'LINE_WORK',
          lineName: 'Working Room Boundary',
          normalizedStartPoint: [0.74, 0.667],
          normalizedEndPoint: [0.391, 0.722],
          directionMapping: {
            forward: { event: 'WORK_ROOM_ENTERED', from: 'PASSAGE', to: 'WORK_ROOM' },
            backward: { event: 'WORK_ROOM_EXITED', from: 'WORK_ROOM', to: 'PASSAGE' },
          },
          enabled: true,
        },
        {
          id: 'line_exit',
          cameraId: selectedCameraId,
          channelNo: 1,
          lineId: 'LINE_EXIT',
          lineName: 'Outside Office Exit Boundary',
          normalizedStartPoint: [0.771, 0.787],
          normalizedEndPoint: [0.979, 0.944],
          directionMapping: {
            forward: { event: 'OFFICE_ENTRY_OBSERVED', from: 'MAIN_EXIT', to: 'PASSAGE' },
            backward: { event: 'OFFICE_EXIT_OBSERVED', from: 'PASSAGE', to: 'MAIN_EXIT' },
          },
          enabled: true,
        },
      ]);
    }
  };

  const selectedCamera = cameras.find((c) => c.id === selectedCameraId);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header />

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        {/* Title Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-blue-50 text-blue-700 border border-blue-200">
                System A — Office Zones & Doorways
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live Camera Tracking
              </span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">
              Office Zone Calibration & Doorway Monitoring
            </h1>
            <p className="text-sm text-slate-500">
              Interactive dual-lens visual calibration canvas, directional crossing boundaries, and real-time person movement tracking.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => selectedCameraId && loadSnapshot(selectedCameraId, selectedChannel)}
              disabled={snapshotLoading}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${snapshotLoading ? 'animate-spin' : ''}`} />
              Refresh Snapshot
            </button>

            <button
              onClick={handleSaveConfig}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Save Calibration'}
            </button>
          </div>
        </div>

        {/* System Separation Policy Banner */}
        <div className="p-3.5 bg-blue-50/70 border border-blue-200/80 rounded-xl text-xs text-blue-900 flex items-start gap-2.5 shadow-sm">
          <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
          <div className="leading-relaxed">
            <span className="font-bold">Strict System Separation Principle:</span> Person detection, doorway boundary crossings, and room occupancy are purely observational presence evidence. In strict accordance with company privacy and operational policy, camera tracking <b>never</b> silently creates official payroll check-in/out records, and <b>never</b> calculates employee productivity or paid hours from camera visibility.
          </div>
        </div>

        {saveStatus && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-semibold text-emerald-800 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            {saveStatus}
          </div>
        )}

        {/* Real-time Telemetry Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Detected People</p>
            <h4 className="text-xl font-bold text-slate-900 mt-1">{metrics.detectedPeople}</h4>
            <p className="text-[10px] text-slate-400">Current frame bodies</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs">
            <p className="text-[11px] font-semibold text-blue-600 uppercase tracking-wider">Active Tracks</p>
            <h4 className="text-xl font-bold text-blue-700 mt-1">{metrics.activeTracks}</h4>
            <p className="text-[10px] text-slate-400">ByteTrack sessions</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs">
            <p className="text-[11px] font-semibold text-emerald-600 uppercase tracking-wider">Verified Employees</p>
            <h4 className="text-xl font-bold text-emerald-700 mt-1">{metrics.verifiedTracks}</h4>
            <p className="text-[10px] text-slate-400">SFace biometric match</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs">
            <p className="text-[11px] font-semibold text-amber-600 uppercase tracking-wider">Unidentified Tracks</p>
            <h4 className="text-xl font-bold text-amber-700 mt-1">{metrics.unidentifiedTracks}</h4>
            <p className="text-[10px] text-slate-400">Anonymous in transit</p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs col-span-2 sm:col-span-1">
            <p className="text-[11px] font-semibold text-indigo-600 uppercase tracking-wider">Inference Speed</p>
            <h4 className="text-xl font-bold text-indigo-700 mt-1">
              {metrics.fps > 0 ? metrics.fps.toFixed(1) : '2.5'}{' '}
              <span className="text-xs font-normal text-slate-500">FPS</span>
            </h4>
            <p className="text-[10px] text-slate-400">Live dual-lens pipeline</p>
          </div>
        </div>

        {/* Layout Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Main Visualizer (8 cols) */}
          <div className="lg:col-span-8 space-y-6">
            {/* Visual Canvas Card */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              {/* Toolbar */}
              <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-600">Camera Lens:</span>
                    <div className="inline-flex rounded-lg border border-slate-300 p-0.5 bg-white text-xs font-semibold shadow-xs">
                      <button
                        onClick={() => setSelectedChannel(1)}
                        className={`px-3 py-1 rounded-md transition-colors ${
                          selectedChannel === 1
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Channel 1 (Wide Lens — Tracking)
                      </button>
                      <button
                        onClick={() => setSelectedChannel(2)}
                        className={`px-3 py-1 rounded-md transition-colors ${
                          selectedChannel === 2
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Channel 2 (Pan-Tilt — Workstation)
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                      frameInfo.cameraConnectionStatus === 'LIVE'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}>
                      <span className={`w-2 h-2 rounded-full ${frameInfo.cameraConnectionStatus === 'LIVE' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                      <span>{frameInfo.cameraConnectionStatus || 'LIVE'}</span>
                      {frameInfo.frameId ? (
                        <span className="text-slate-400 font-mono text-[10px]">#{frameInfo.frameId}</span>
                      ) : null}
                    </span>
                    {frameInfo.frameTimestamp && (
                      <span className="text-[10px] text-slate-400 font-mono hidden md:inline">
                        {new Date(frameInfo.frameTimestamp).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={showTracks}
                      onChange={(e) => setShowTracks(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="flex items-center gap-1">
                      <span>Live Person Tracks</span>
                      {activeTracks.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-700 font-bold">
                          {activeTracks.length}
                        </span>
                      )}
                    </span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={showZones}
                      onChange={(e) => setShowZones(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>Office Zones</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={showLines}
                      onChange={(e) => setShowLines(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>Doorway Lines</span>
                  </label>

                  <div className="h-4 w-px bg-slate-200 mx-1 hidden sm:block" />

                  <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-700" title="Automatically pull fresh camera frame from EZVIZ to keep image synchronized with live tracks">
                    <input
                      type="checkbox"
                      checked={autoRefreshSnapshot}
                      onChange={(e) => setAutoRefreshSnapshot(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>Auto-Sync Frame</span>
                  </label>

                  <button
                    onClick={() => loadSnapshot(selectedCameraId, selectedChannel)}
                    disabled={snapshotLoading}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold border border-slate-300 disabled:opacity-60 transition-colors"
                    title="Capture fresh live frame from EZVIZ camera"
                  >
                    <RefreshCw className={`w-3 h-3 ${snapshotLoading ? 'animate-spin' : ''}`} />
                    <span>{snapshotLoading ? 'Syncing...' : 'Sync Frame'}</span>
                  </button>
                </div>
              </div>

              {/* Viewport Container */}
              <div className="relative aspect-video w-full bg-slate-950 flex items-center justify-center overflow-hidden">
                {snapshotTimestamp && (
                  <div className="absolute top-3 left-3 bg-slate-900/80 backdrop-blur px-2.5 py-1 rounded-md text-[10px] font-mono text-slate-300 border border-slate-700 z-20 flex items-center gap-1.5 pointer-events-none">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span>Frame Synced: {new Date(snapshotTimestamp).toLocaleTimeString()}</span>
                  </div>
                )}
                {snapshotUrl ? (
                  <img
                    ref={imgRef}
                    src={snapshotUrl}
                    alt="Camera Live View"
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
                  />
                ) : (
                  <div className="text-center p-8 text-slate-400">
                    <Layers className="w-10 h-10 mx-auto text-slate-500 mb-2 animate-pulse" />
                    <p className="text-sm font-semibold">Live Camera Stream Ingesting</p>
                    <p className="text-xs text-slate-500 mt-1">EZVIZ CS-H7c Dual-Lens Hardware Connected</p>
                  </div>
                )}

                {/* Overlay Canvas */}
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 w-full h-full z-10"
                />

                {snapshotLoading && (
                  <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-20">
                    <div className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg shadow-lg text-xs">
                      <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />
                      <span>Capturing fresh camera frame...</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Visual Legend */}
              <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex flex-col gap-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="font-semibold text-slate-600">Doorway Boundaries:</span>
                    <div className="flex items-center gap-1.5 font-medium text-slate-700">
                      <span className="w-3 h-1 bg-amber-500 rounded" />
                      <span>Left: Lunch Room</span>
                    </div>
                    <div className="flex items-center gap-1.5 font-medium text-slate-700">
                      <span className="w-3 h-1 bg-blue-600 rounded" />
                      <span>Center: Working Room</span>
                    </div>
                    <div className="flex items-center gap-1.5 font-medium text-slate-700">
                      <span className="w-3 h-1 bg-rose-600 rounded" />
                      <span>Right: Outside Exit</span>
                    </div>
                  </div>

                  <button
                    onClick={handleResetToApproved}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800 transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset to Approved Baseline
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-200/60">
                  <span className="font-semibold text-slate-600">v2.9 Identity Tracking:</span>
                  <div className="flex items-center gap-1.5 font-medium text-slate-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    <span>Latched (Face Visible)</span>
                  </div>
                  <div className="flex items-center gap-1.5 font-medium text-slate-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                    <span>Tracking Without Face [TWF]</span>
                  </div>
                  <div className="flex items-center gap-1.5 font-medium text-slate-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
                    <span>Candidate [~]</span>
                  </div>
                  <div className="flex items-center gap-1.5 font-medium text-slate-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
                    <span>Uncertain [?]</span>
                  </div>
                  <div className="flex items-center gap-1.5 font-medium text-slate-700">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                    <span>Unidentified</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Calibration Coordinates Table */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setActiveTab('lines')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      activeTab === 'lines'
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'text-slate-600 hover:bg-slate-200/50'
                    }`}
                  >
                    Doorway Crossing Lines ({lines.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('zones')}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      activeTab === 'zones'
                        ? 'bg-blue-600 text-white shadow-xs'
                        : 'text-slate-600 hover:bg-slate-200/50'
                    }`}
                  >
                    Polygon Zones ({zones.length})
                  </button>
                </div>
                <span className="text-[11px] text-slate-500">Normalized [0.000 — 1.000]</span>
              </div>

              {activeTab === 'lines' ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50/80 text-slate-500 font-semibold border-b border-slate-100">
                      <tr>
                        <th className="py-2.5 px-4">Doorway Line</th>
                        <th className="py-2.5 px-4">Start Point [X, Y]</th>
                        <th className="py-2.5 px-4">End Point [X, Y]</th>
                        <th className="py-2.5 px-4">Forward Direction</th>
                        <th className="py-2.5 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {lines.map((l, idx) => (
                        <tr key={l.lineId} className="hover:bg-slate-50/50 transition-colors">
                          <td className="py-3 px-4">
                            <span className="font-bold text-slate-900 block">{l.lineName}</span>
                            <span className="text-[10px] text-slate-400 font-mono">{l.lineId}</span>
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px]">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                step="0.005"
                                min="0"
                                max="1"
                                value={l.normalizedStartPoint[0]}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  const copy = [...lines];
                                  copy[idx].normalizedStartPoint[0] = val;
                                  setLines(copy);
                                }}
                                className="w-16 px-1.5 py-0.5 border rounded text-xs"
                              />
                              <input
                                type="number"
                                step="0.005"
                                min="0"
                                max="1"
                                value={l.normalizedStartPoint[1]}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  const copy = [...lines];
                                  copy[idx].normalizedStartPoint[1] = val;
                                  setLines(copy);
                                }}
                                className="w-16 px-1.5 py-0.5 border rounded text-xs"
                              />
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px]">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                step="0.005"
                                min="0"
                                max="1"
                                value={l.normalizedEndPoint[0]}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  const copy = [...lines];
                                  copy[idx].normalizedEndPoint[0] = val;
                                  setLines(copy);
                                }}
                                className="w-16 px-1.5 py-0.5 border rounded text-xs"
                              />
                              <input
                                type="number"
                                step="0.005"
                                min="0"
                                max="1"
                                value={l.normalizedEndPoint[1]}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  const copy = [...lines];
                                  copy[idx].normalizedEndPoint[1] = val;
                                  setLines(copy);
                                }}
                                className="w-16 px-1.5 py-0.5 border rounded text-xs"
                              />
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                              {l.directionMapping?.forward?.event || 'FORWARD'}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700">
                              Active
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50/80 text-slate-500 font-semibold border-b border-slate-100">
                      <tr>
                        <th className="py-2.5 px-4">Zone Name</th>
                        <th className="py-2.5 px-4">Zone ID</th>
                        <th className="py-2.5 px-4">Polygon Vertices</th>
                        <th className="py-2.5 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {zones.map((z) => (
                        <tr key={z.zoneId} className="hover:bg-slate-50/50 transition-colors">
                          <td className="py-3 px-4 font-bold text-slate-900">{z.zoneName}</td>
                          <td className="py-3 px-4 font-mono text-[11px] text-slate-500">{z.zoneId}</td>
                          <td className="py-3 px-4 font-mono text-[11px] text-slate-600">
                            {z.normalizedPolygon?.length || 0} coordinate pairs
                          </td>
                          <td className="py-3 px-4">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700">
                              Enabled
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Live Telemetry & Movement Timeline (4 cols) */}
          <div className="lg:col-span-4 space-y-6">
            {/* Active Tracks Card */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-600" />
                  <h3 className="text-sm font-bold text-slate-900">Active Camera Tracks</h3>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                  {activeTracks.length} Active
                </span>
              </div>

              <div className="p-4 space-y-2.5 max-h-64 overflow-y-auto">
                {activeTracks.length === 0 ? (
                  <div className="py-8 text-center text-slate-400 text-xs">
                    <Eye className="w-6 h-6 mx-auto mb-1 text-slate-300" />
                    No moving persons currently in camera frame
                  </div>
                ) : (
                  activeTracks.map((t) => {
                    const isSelected = selectedFilterEmployeeId === t.employeeId;
                    return (
                      <div
                        key={t.id}
                        onClick={() => {
                          if (t.employeeId) {
                            setSelectedFilterEmployeeId(isSelected ? null : t.employeeId);
                          }
                        }}
                        className={`p-3 rounded-xl border transition-all text-xs flex items-start justify-between gap-2 cursor-pointer ${
                          isSelected
                            ? 'border-blue-500 bg-blue-50/60 shadow-xs'
                            : 'border-slate-100 bg-slate-50/50 hover:bg-slate-50'
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-900">{t.employeeName}</span>
                            {t.employeeCode === '22IT0512' && (
                              <span className="px-1.5 py-0.2 bg-blue-100 text-blue-700 text-[9px] font-bold rounded">
                                You
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500">
                            <span className="font-mono">Track #{t.trackId}</span>
                            <span>•</span>
                            <span className="font-medium text-blue-600">{t.currentZoneId}</span>
                            <span>•</span>
                            <span>{t.freshnessSec ?? 0}s ago</span>
                          </div>
                        </div>

                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            t.identityVerificationStatus === 'VERIFIED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {t.identityVerificationStatus}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Doorway Movement Activity Timeline */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <MoveRight className="w-4 h-4 text-blue-600" />
                  <h3 className="text-sm font-bold text-slate-900">Doorway Activity Stream</h3>
                </div>
                <div className="flex items-center gap-2">
                  {selectedFilterEmployeeId && (
                    <button
                      onClick={() => setSelectedFilterEmployeeId(null)}
                      className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold hover:bg-blue-200"
                    >
                      Clear Filter
                    </button>
                  )}
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
                    <Radio className="w-3 h-3 text-emerald-500 animate-pulse" />
                    Live 3s
                  </span>
                </div>
              </div>

              <div className="p-4 space-y-3 max-h-[500px] overflow-y-auto">
                {transitions.filter((item) => !selectedFilterEmployeeId || item.employeeId === selectedFilterEmployeeId).length === 0 ? (
                  <div className="py-12 text-center text-slate-400 text-xs">
                    <Clock className="w-6 h-6 mx-auto mb-1 text-slate-300" />
                    {selectedFilterEmployeeId
                      ? 'No doorway crossings recorded for this employee'
                      : 'No doorway crossings recorded yet today'}
                  </div>
                ) : (
                  transitions
                    .filter((item) => !selectedFilterEmployeeId || item.employeeId === selectedFilterEmployeeId)
                    .map((item) => {
                    const isVerified = item.verificationStatus === 'VERIFIED';
                    return (
                      <div
                        key={item.id}
                        className="relative pl-5 border-l-2 border-slate-200 space-y-1 text-xs pb-3 last:pb-0"
                      >
                        <span
                          className={`absolute -left-[5px] top-1 w-2 h-2 rounded-full ${
                            isVerified ? 'bg-emerald-500' : 'bg-slate-400'
                          }`}
                        />

                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-semibold text-slate-800">
                            {item.employeeName || 'Anonymous Person'}
                          </span>
                          <span className="font-mono text-slate-400 text-[10px]">
                            {formatTime(item.observedAt)}
                          </span>
                        </div>

                        <div className="flex items-center gap-1 text-[11px] text-slate-600">
                          <span className="font-medium text-slate-900">{item.eventType.replace(/_/g, ' ')}</span>
                        </div>

                        <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                          <span className="px-1.5 py-0.2 rounded bg-slate-100 font-mono">{item.fromZoneId}</span>
                          <ArrowRight className="w-2.5 h-2.5 text-slate-400" />
                          <span className="px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 font-mono font-semibold">
                            {item.toZoneId}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
