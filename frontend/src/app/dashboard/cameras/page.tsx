'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Cctv, Settings } from 'lucide-react';
import { Header } from '@/components/Header';
import { CameraCard } from '@/components/CameraCard';
import { VideoPlayer } from '@/components/VideoPlayer';
import { LivePreview } from '@/components/LivePreview';
import { Card, CardHeader, EmptyState, Skeleton, btn } from '@/components/ui';
import { settingsApi, type CameraRecord } from '@/lib/api';
import { useShell } from '@/components/shell/ShellContext';

export default function CamerasPage() {
  const [cameras, setCameras] = useState<CameraRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    settingsApi
      .cameras()
      .then((res) => {
        // Cameras turned off in Settings are not shown here.
        const on = res.data.filter((c) => c.isEnabled !== false);
        setCameras(on);
        setSelectedId((id) => id ?? on[0]?.id ?? null);
      })
      .catch((e) => {
        setError(e.message || 'Could not load cameras');
        setCameras([]);
      });
  }, []);

  const selected = cameras?.find((c) => c.id === selectedId) ?? null;
  const canSetup = useShell().can('setup.manage');
  const manage = canSetup ? (
    <Link href="/dashboard/settings?tab=cameras" className={btn.secondary}>
      <Settings className="w-4 h-4" />
      Manage cameras
    </Link>
  ) : undefined;

  return (
    <>
      <Header actions={manage} />

      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] w-full mx-auto">
        {error && <p className="text-[13px] text-rose-700">{error}</p>}

        {cameras === null ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Skeleton className="lg:col-span-2 h-80 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        ) : cameras.length === 0 ? (
          <Card>
            <EmptyState
              icon={Cctv}
              title="No cameras to show"
              description={canSetup ? 'Add a camera, or turn one back on, in Settings.' : 'Ask an admin to add a camera.'}
              action={
                canSetup ? (
                  <Link href="/dashboard/settings?tab=cameras" className={btn.primary}>
                    Go to camera settings
                  </Link>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
            <div className="lg:col-span-2 space-y-4">
              {selected && (
                <>
                  {selected.connectionType === 'EZVIZ' ? (
                    <VideoPlayer
                      key={selected.id}
                      cameraId={selected.id}
                      serialNumber={selected.serialNumber}
                      cameraName={selected.name}
                      channels={selected.channels}
                    />
                  ) : (
                    <LivePreview key={selected.id} camera={selected} />
                  )}
                  <Card>
                    <CardHeader title="Camera details" />
                    <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 px-5 pb-5 text-[13px]">
                      {[
                        ['Connection', ({ EZVIZ: 'EZVIZ cloud', RTSP: 'IP camera (RTSP)', HTTP: 'Web link', USB: 'USB camera' } as Record<string, string>)[selected.connectionType] ?? selected.connectionType],
                        ['Model', selected.model],
                        selected.connectionType === 'EZVIZ' ? ['Serial number', selected.serialNumber] : ['Address', selected.host ? `${selected.host}${selected.port ? `:${selected.port}` : ''}` : '—'],
                        ['Firmware', selected.firmwareVer || '—'],
                        ['Where it is', selected.location || '—'],
                      ].map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="text-slate-500">{k}</dt>
                          <dd className="mt-0.5 font-medium text-slate-900 truncate">{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="px-5 pb-5">
                      <p className="text-[13px] text-slate-500">Lenses</p>
                      <ul className="mt-1.5 space-y-1 text-[13px] text-slate-700">
                        {selected.channels.map((ch) => (
                          <li key={ch.channelNo}>
                            <span className="text-slate-400 tabular-nums">Lens {ch.channelNo}</span> · {ch.channelName}
                            {!ch.recognitionEnabled && <span className="text-slate-400"> · face recognition off</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Card>
                </>
              )}
            </div>

            <div className="space-y-3">
              <p className="text-[13px] font-medium text-slate-700">
                {cameras.length} camera{cameras.length === 1 ? '' : 's'}
              </p>
              {cameras.map((cam) => (
                <CameraCard key={cam.id} camera={cam} onSelect={(c) => setSelectedId(c.id)} isSelected={selectedId === cam.id} />
              ))}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
