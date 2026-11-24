'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import {
  Play,
  Pause,
  RotateCw,
  Maximize2,
  Minimize2,
  Camera,
  Layers,
  AlertCircle,
  CheckCircle2,
  Volume2,
  VolumeX,
  Info,
} from 'lucide-react';
import { api } from '@/lib/api';

interface VideoPlayerProps {
  cameraId: string;
  serialNumber: string;
  cameraName: string;
  channels?: { channelNo: number; channelName: string }[];
  initialChannel?: number;
}

export function VideoPlayer({
  cameraId,
  serialNumber,
  cameraName,
  channels = [
    { channelNo: 1, channelName: 'Hashnate -WL (Wide Lens)' },
    { channelNo: 2, channelName: 'Hashnate -PT (Pan-Tilt Lens)' },
  ],
  initialChannel = 1,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [activeChannel, setActiveChannel] = useState<number>(initialChannel);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [streamInfo, setStreamInfo] = useState<{ url: string; expireTime?: string } | null>(null);
  const [snapshotPreview, setSnapshotPreview] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);

  // Clean up previous HLS instance
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  // Fetch stream and initialize player
  const loadStream = useCallback(async (channelNo: number) => {
    setStatus('loading');
    setErrorMessage(null);
    destroyHls();

    try {
      // 1. Fetch authorized HLS stream URL from WorkSight backend
      const res = await api.getStreamUrl(cameraId, channelNo, 2);
      if (!res.success || !res.data?.streamUrl) {
        throw new Error('No live streaming URL returned by EZVIZ gateway');
      }

      const streamUrl = res.data.streamUrl;
      setStreamInfo({ url: streamUrl, expireTime: res.data.expireTime });

      const video = videoRef.current;
      if (!video) return;

      // 2. Check if HLS.js is supported in this browser
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 30,
        });

        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play()
            .then(() => {
              setIsPlaying(true);
              setStatus('playing');
            })
            .catch((playErr) => {
              console.warn('Autoplay prevented:', playErr);
              setStatus('idle');
            });
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          console.error('[HLS.js error]', data);
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('Fatal network error encountered, attempting recovery...');
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('Fatal media error encountered, recovering media...');
                hls.recoverMediaError();
                break;
              default:
                destroyHls();
                setStatus('error');
                setErrorMessage(`Streaming error: ${data.details || 'Unable to play stream'}`);
                break;
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native Safari HLS
        video.src = streamUrl;
        video.play()
          .then(() => {
            setIsPlaying(true);
            setStatus('playing');
          })
          .catch((e) => {
            console.warn('Native playback error:', e);
            setStatus('idle');
          });
      } else {
        throw new Error('Your browser does not support HLS video playback.');
      }
    } catch (err: any) {
      console.error('Failed to load stream:', err);
      setStatus('error');
      setErrorMessage(err.message || 'Failed to connect to EZVIZ camera stream');
    }
  }, [cameraId, destroyHls]);

  // Initial load
  useEffect(() => {
    loadStream(activeChannel);
    return () => {
      destroyHls();
    };
  }, [activeChannel, loadStream, destroyHls]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().then(() => setIsPlaying(true));
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true));
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false));
    }
  };

  // Instant Snapshot
  const handleCaptureSnapshot = async () => {
    try {
      setIsCapturing(true);
      const res = await api.captureSnapshot(cameraId, activeChannel);
      if (res.success && res.data?.picUrl) {
        setSnapshotPreview(res.data.picUrl);
      }
    } catch (err: any) {
      alert(`Snapshot failed: ${err.message}`);
    } finally {
      setIsCapturing(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="bg-slate-950 rounded-xl overflow-hidden border border-slate-800 shadow-xl flex flex-col relative group"
    >
      {/* Player Header Bar */}
      <div className="bg-slate-900/90 backdrop-blur px-3 sm:px-4 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 text-white z-10">
        <div className="flex items-center gap-3 min-w-0">
          <span className="relative flex h-2.5 w-2.5">
            {status === 'playing' ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </>
            ) : status === 'loading' ? (
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400 animate-pulse"></span>
            ) : (
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500"></span>
            )}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight text-white flex flex-wrap items-center gap-x-2 gap-y-1">
              {cameraName}
              <span className="hidden sm:inline text-[11px] font-normal text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                S/N: {serialNumber}
              </span>
            </h3>
          </div>
        </div>

        {/* Dual Lens Channel Switcher */}
        <div className="flex items-center gap-1.5 bg-slate-950/70 p-1 rounded-lg border border-slate-800">
          <Layers className="hidden sm:block w-3.5 h-3.5 text-slate-400 ml-1.5 mr-1" />
          {channels.map((ch) => (
            <button
              key={ch.channelNo}
              onClick={() => setActiveChannel(ch.channelNo)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                activeChannel === ch.channelNo
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              Ch {ch.channelNo}<span className="hidden sm:inline">: {ch.channelNo === 1 ? 'Wide Lens' : 'Pan-Tilt'}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Main Video Viewport */}
      <div className="relative aspect-video w-full bg-black flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted={isMuted}
          className="w-full h-full object-contain"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />

        {/* Overlay: Connecting / Loading State */}
        {status === 'loading' && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3 text-slate-300 z-20">
            <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm font-medium text-slate-200">Connecting to EZVIZ Media Gateway...</p>
            <p className="text-xs text-slate-400">Loading HLS stream for Channel {activeChannel} ({activeChannel === 1 ? 'Hashnate -WL' : 'Hashnate -PT'})</p>
          </div>
        )}

        {/* Overlay: Playback Error */}
        {status === 'error' && (
          <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center gap-3 p-6 text-center text-slate-300 z-20">
            <AlertCircle className="w-10 h-10 text-rose-500" />
            <h4 className="text-base font-semibold text-white">Stream Connection Failed</h4>
            <p className="text-xs text-slate-400 max-w-md">{errorMessage || 'Unable to establish video connection with EZVIZ Open Platform.'}</p>
            <button
              onClick={() => loadStream(activeChannel)}
              className="mt-2 flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold shadow-md transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5" /> Reconnect Live Stream
            </button>
          </div>
        )}

        {/* Bottom Video Controls Overlay (Fade in on hover) */}
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-slate-950/90 via-slate-950/50 to-transparent p-2.5 sm:p-4 flex items-center justify-between gap-2 text-white opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-200 z-10">
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={togglePlay}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>

            <button
              onClick={() => loadStream(activeChannel)}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              title="Refresh Stream"
            >
              <RotateCw className="w-4 h-4" />
            </button>

            <button
              onClick={toggleMute}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>

            <span className="hidden sm:flex text-xs font-mono text-emerald-400 items-center gap-1.5 ml-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span> LIVE
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCaptureSnapshot}
              disabled={isCapturing}
              className="flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
              title="Capture instantaneous frame"
              aria-label="Snapshot"
            >
              <Camera className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{isCapturing ? 'Capturing...' : 'Snapshot'}</span>
            </button>

            <button
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              title="Stream Diagnostics"
            >
              <Info className="w-4 h-4" />
            </button>

            <button
              onClick={toggleFullscreen}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Stream Diagnostics Box */}
      {showDiagnostics && (
        <div className="p-4 bg-slate-900 border-t border-slate-800 text-xs text-slate-300 font-mono space-y-1">
          <div className="flex justify-between items-center text-slate-400 font-semibold mb-2">
            <span>EZVIZ Open Platform Diagnostics</span>
            <button onClick={() => setShowDiagnostics(false)} className="hover:text-white">✕</button>
          </div>
          <p><span className="text-slate-500">Protocol:</span> HLS (HTTP Live Streaming - m3u8)</p>
          <p><span className="text-slate-500">Target Channel:</span> Channel {activeChannel} ({channels.find(c => c.channelNo === activeChannel)?.channelName})</p>
          <p><span className="text-slate-500">Stream Expiration:</span> {streamInfo?.expireTime || 'Permanent / Session Valid'}</p>
          <p className="break-all sm:truncate"><span className="text-slate-500">Authorized Endpoint:</span> {streamInfo?.url || 'N/A'}</p>
        </div>
      )}

      {/* Instant Snapshot Preview Modal / Banner */}
      {snapshotPreview && (
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={snapshotPreview}
              alt="Snapshot capture"
              className="w-20 h-12 object-cover rounded border border-slate-700 shadow"
            />
            <div>
              <p className="text-xs font-semibold text-white">Live Snapshot Captured</p>
              <p className="text-[11px] text-slate-400">Captured from Channel {activeChannel} via EZVIZ Device Capture API</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={snapshotPreview}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium"
            >
              Open Image
            </a>
            <button
              onClick={() => setSnapshotPreview(null)}
              className="px-2 py-1 text-slate-400 hover:text-white text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

