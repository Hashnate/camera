'use client';

/**
 * Live view for cameras a browser can't play directly (RTSP, USB, HTTP links): a fresh picture about once a
 * second from the AI service, which already holds the stream open. EZVIZ cameras use VideoPlayer (HLS) instead.
 */

import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { settingsApi, type CameraRecord } from '@/lib/api';

export function LivePreview({ camera }: { camera: CameraRecord }) {
  const [lens, setLens] = useState(camera.channels[0]?.channelNo ?? 1);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSrc(null);
    setError(null);
    const tick = async () => {
      if (document.hidden && !first) {
        timer = setTimeout(tick, 1000); // keep the last picture; don't pull new ones for a hidden tab
        return;
      }
      first = false;
      let wait = 1000;
      try {
        const blob = await settingsApi.cameraPreview(camera.id, lens);
        if (stopped) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setSrc(url);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (e: any) {
        if (stopped) return;
        setError(e.message || 'No picture from the camera');
        wait = 4000;
      }
      if (!stopped) timer = setTimeout(tick, wait);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [camera.id, lens]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  const stale = updatedAt !== null && Date.now() - updatedAt > 6000;
  return (
    <section className="rounded-2xl overflow-hidden bg-slate-950 ring-1 ring-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${error ? 'bg-rose-500' : src && !stale ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
          <p className="text-[13.5px] font-semibold text-white truncate">{camera.name}</p>
          <span className="text-[12px] text-slate-400 shrink-0">{error ? 'No picture' : src ? 'Live · about 1 picture a second' : 'Connecting…'}</span>
        </div>
        {camera.channels.length > 1 && (
          <div className="flex gap-1 rounded-lg bg-white/5 p-1" role="tablist" aria-label="Lens">
            {camera.channels.map((ch) => (
              <button
                key={ch.channelNo}
                type="button"
                role="tab"
                aria-selected={lens === ch.channelNo}
                onClick={() => setLens(ch.channelNo)}
                className={`px-2.5 h-7 rounded-md text-[12px] font-medium transition-colors ${
                  lens === ch.channelNo ? 'bg-white text-slate-900' : 'text-slate-300 hover:text-white'
                }`}
              >
                {ch.channelName}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="relative aspect-video">
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={`Live picture from ${camera.name}`} className="absolute inset-0 w-full h-full object-contain" />
        )}
        {!src && !error && <div className="absolute inset-0 animate-pulse bg-white/5" />}
        {error && (
          <div className={`absolute inset-x-0 bottom-0 m-3 flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12.5px] ${src ? 'bg-black/70 text-rose-200' : 'text-rose-200'}`} role="alert">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </section>
  );
}
