'use client';

/**
 * Settings > Cameras: add cameras of any kind and manage them.
 *
 * Ways to add: find on the network (ONVIF), IP camera / recorder by brand (RTSP), EZVIZ cloud account,
 * USB / built-in camera, or a picture / stream link. Every way ends with a test that shows a real picture
 * before the camera is saved.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Cctv,
  Check,
  Cloud,
  Eye,
  Link2,
  Loader2,
  Plus,
  Power,
  Radar,
  RefreshCw,
  Search,
  Trash2,
  Usb,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardHeader, EmptyState, Skeleton, btn } from '@/components/ui';
import { Field, Notice, StatusText, Switch, inputBase, type Tone } from '@/components/settings/parts';
import {
  settingsApi,
  type CameraBrand,
  type CameraChanges,
  type CameraConnection,
  type CameraRecord,
  type CameraTestResult,
  type DiscoveredCamera,
  type NetworkCamera,
  type OnvifStreams,
  type RecognitionStatus,
} from '@/lib/api';

type Notify = (message: string, type?: 'success' | 'error') => void;

const TYPE_LABEL: Record<string, string> = {
  EZVIZ: 'EZVIZ cloud',
  RTSP: 'IP camera (RTSP)',
  HTTP: 'Web link',
  USB: 'USB camera',
};

// ---------------------------------------------------------------- status helpers

function channelStates(cam: CameraRecord, status: RecognitionStatus | null) {
  return (status?.channels ?? []).filter((c) => c.cameraId === cam.id);
}

function cameraState(cam: CameraRecord, status: RecognitionStatus | null): { tone: Tone; text: string } {
  if (!cam.isEnabled) return { tone: 'slate', text: 'Turned off' };
  if (cam.connectionType === 'EZVIZ') {
    return cam.status === 'ONLINE' ? { tone: 'emerald', text: 'Online' } : { tone: 'rose', text: 'Offline in EZVIZ' };
  }
  const states = channelStates(cam, status);
  if (states.some((s) => s.state === 'running')) return { tone: 'emerald', text: 'Connected' };
  if (states.some((s) => s.state === 'error')) return { tone: 'rose', text: "Can't connect" };
  return cam.status === 'ONLINE' ? { tone: 'emerald', text: 'Reachable' } : { tone: 'slate', text: 'Not checked yet' };
}

function lensState(cam: CameraRecord, lens: CameraRecord['channels'][number], status: RecognitionStatus | null): { tone: Tone; text: string } {
  if (!cam.isEnabled) return { tone: 'slate', text: 'Camera turned off' };
  if (!lens.recognitionEnabled) return { tone: 'slate', text: 'Not recognising faces' };
  if (!status) return { tone: 'slate', text: 'Checking…' };
  if (!status.reachable) return { tone: 'rose', text: 'AI service is not running' };
  if (status.workerEnabled === false) return { tone: 'slate', text: 'Recognition is switched off in the AI service' };
  const ch = status.channels?.find((c) => c.cameraId === cam.id && c.channelNo === lens.channelNo);
  if (!ch) return { tone: 'amber', text: 'Starting within 30 seconds' };
  if (ch.state === 'running') return { tone: 'emerald', text: `Recognising · ${ch.source === 'snapshot' || ch.source === 'http' ? 'snapshots' : 'live video'}` };
  if (ch.state === 'error') return { tone: 'rose', text: ch.lastError || 'Error' };
  if (ch.state === 'idle') return { tone: 'slate', text: ch.lastError || 'Idle' };
  return { tone: 'amber', text: 'Connecting…' };
}

// ---------------------------------------------------------------- pictures

function TestPicture({ result }: { result: CameraTestResult | null }) {
  if (!result) return null;
  if (!result.ok) return <Notice tone="error">{result.message}</Notice>;
  return (
    <figure className="space-y-2">
      {result.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={result.image} alt="Picture from the camera" className="w-full max-w-xl aspect-video object-contain bg-slate-900 rounded-xl" />
      )}
      <figcaption>
        <StatusText tone="emerald">{result.message}</StatusText>
      </figcaption>
    </figure>
  );
}

/** Current picture of a saved camera lens (any type). */
function LensPicture({ cameraId, channelNo, onClose }: { cameraId: string; channelNo: number; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    settingsApi
      .cameraPreview(cameraId, channelNo)
      .then((blob) => setSrc((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      }))
      .catch((e) => setError(e.message || 'No picture'));
  }, [cameraId, channelNo]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src);
  }, [src]);
  return (
    <div className="mt-3 space-y-2">
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`Picture from lens ${channelNo}`} className="w-full max-w-xl aspect-video object-contain bg-slate-900 rounded-xl" />
      ) : (
        <Skeleton className="w-full max-w-xl aspect-video rounded-xl" />
      )}
      <div className="flex gap-3">
        <button type="button" className={btn.ghost} onClick={load}>
          <RefreshCw className="w-3.5 h-3.5" /> New picture
        </button>
        <button type="button" className={btn.ghost} onClick={onClose}>
          Hide
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- adding: shared finish step

function FinishAdd({
  test,
  defaultName,
  onAdd,
}: {
  test: CameraTestResult | null;
  defaultName: string;
  onAdd: (name: string, location: string) => Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(defaultName), [defaultName]);
  if (!test) return null;
  return (
    <div className="space-y-4 border-t border-slate-100 pt-4">
      <TestPicture result={test} />
      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Field id="new-cam-name" label="Name">
          <input id="new-cam-name" value={name} onChange={(e) => setName(e.target.value)} className={`${inputBase} w-full`} />
        </Field>
        <Field id="new-cam-loc" label="Where it is" optional>
          <input id="new-cam-loc" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Main hall, facing the door" className={`${inputBase} w-full`} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={btn.primary}
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onAdd(name.trim(), location.trim());
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          {test.ok ? 'Add camera' : 'Add anyway'}
        </button>
        {!test.ok && <span className="text-[12.5px] text-slate-500">You can add it now and fix the details later.</span>}
      </div>
    </div>
  );
}

function useTest() {
  const [test, setTest] = useState<CameraTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const run = async (body: CameraConnection) => {
    setTesting(true);
    setTest(null);
    try {
      const res = await settingsApi.testCamera(body);
      setTest(res.data);
    } catch (e: any) {
      setTest({ ok: false, message: e.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };
  return { test, testing, run, reset: () => setTest(null) };
}

function TestButton({ testing, disabled, onClick }: { testing: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={btn.primary} disabled={testing || disabled} onClick={onClick}>
      {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
      {testing ? 'Connecting…' : 'Test connection'}
    </button>
  );
}

type AddProps = { onAdded: (c: CameraRecord) => void; notify: Notify };

async function addAndReport(body: Record<string, any>, { onAdded, notify }: AddProps) {
  try {
    const res = await settingsApi.addCamera(body);
    onAdded(res.data);
    notify(`${res.data.name} added. Recognition starts within 30 seconds.`);
  } catch (e: any) {
    notify(e.message || 'Could not add the camera', 'error');
  }
}

// ---------------------------------------------------------------- adding: IP camera / recorder by brand

function IpCameraForm(props: AddProps) {
  const [brands, setBrands] = useState<CameraBrand[] | null>(null);
  const [brandId, setBrandId] = useState('hikvision');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('554');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [channels, setChannels] = useState('1');
  const [url, setUrl] = useState('');
  const { test, testing, run, reset } = useTest();

  useEffect(() => {
    settingsApi.brands().then((r) => setBrands(r.data)).catch(() => setBrands([]));
  }, []);
  const brand = brands?.find((b) => b.id === brandId);

  const chooseBrand = (id: string) => {
    const b = brands?.find((x) => x.id === id);
    setBrandId(id);
    if (b) {
      setPort(String(b.port));
      setUsername(b.username);
    }
    reset();
  };

  const conn = (): CameraConnection =>
    brand?.needsUrl
      ? { connectionType: 'RTSP', brand: 'custom', streamUrl: url.trim(), username: username.trim(), password }
      : { connectionType: 'RTSP', brand: brandId, host: host.trim(), port: Number(port) || null, username: username.trim(), password, channelNo: 1 };
  const ready = brand?.needsUrl ? url.trim().length > 8 : host.trim().length > 0;
  const count = Math.max(1, Math.min(64, Number(channels) || 1));

  if (!brands) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Field id="ip-brand" label="Brand" className="sm:col-span-2" help={brand?.hint || undefined}>
          <select id="ip-brand" value={brandId} onChange={(e) => chooseBrand(e.target.value)} className={`${inputBase} w-full pr-8`}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        {brand?.needsUrl ? (
          <Field id="ip-url" label="RTSP address" className="sm:col-span-2" help="From the camera's manual, e.g. rtsp://192.168.1.64:554/stream1">
            <input id="ip-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} placeholder="rtsp://" className={`${inputBase} w-full font-mono`} />
          </Field>
        ) : (
          <>
            <Field id="ip-host" label="IP address" help="Shown in the camera's app or your router's device list.">
              <input id="ip-host" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} placeholder="192.168.1.64" className={`${inputBase} w-full font-mono`} />
            </Field>
            <Field id="ip-port" label="RTSP port">
              <input id="ip-port" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputBase} w-28 tabular-nums`} />
            </Field>
          </>
        )}
        <Field id="ip-user" label="Username">
          <input id="ip-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} className={`${inputBase} w-full`} />
        </Field>
        <Field id="ip-pass" label="Password" help="Stored encrypted.">
          <input id="ip-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={`${inputBase} w-full`} />
        </Field>
        {brand && !brand.needsUrl && brand.multiChannel && (
          <Field id="ip-ch" label="Channels" help="1 for a single camera. For a recorder (NVR/DVR), how many cameras are connected to it.">
            <input id="ip-ch" value={channels} onChange={(e) => setChannels(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputBase} w-28 tabular-nums`} />
          </Field>
        )}
      </div>
      <TestButton testing={testing} disabled={!ready} onClick={() => run(conn())} />
      <FinishAdd
        test={test}
        defaultName={brand?.needsUrl ? 'IP camera' : `${brand?.label.split(' (')[0] ?? 'IP'} ${count > 1 ? 'recorder' : 'camera'} (${host.trim()})`}
        onAdd={(name, location) =>
          addAndReport(
            {
              ...conn(),
              ...(brand?.needsUrl ? { channels: [{ streamUrl: url.trim() }] } : { channelCount: count }),
              name,
              location,
              tested: !!test?.ok,
            },
            props
          )
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------- adding: find on the network (ONVIF)

function NetworkScanForm(props: AddProps) {
  const [found, setFound] = useState<NetworkCamera[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ host: string; port: number; deviceUrl?: string; name?: string | null } | null>(null);
  const [manualHost, setManualHost] = useState('');
  const [manualPort, setManualPort] = useState('80');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [streams, setStreams] = useState<OnvifStreams | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const { test, testing, run, reset } = useTest();

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const res = await settingsApi.scanNetwork();
      setFound(res.data);
    } catch (e: any) {
      setScanError(e.message || 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan();
  }, []);

  const choose = (c: { host: string; port: number; deviceUrl?: string; name?: string | null }) => {
    setChosen(c);
    setStreams(null);
    setConnectError(null);
    reset();
  };

  const connect = async () => {
    if (!chosen) return;
    setConnecting(true);
    setConnectError(null);
    setStreams(null);
    reset();
    try {
      const res = await settingsApi.onvifStreams({ host: chosen.host, port: chosen.port, username: username.trim(), password, deviceUrl: chosen.deviceUrl });
      setStreams(res.data);
      const first = res.data.lenses[0];
      if (first) await run({ connectionType: 'RTSP', streamUrl: first.streamUrl, username: username.trim(), password });
    } catch (e: any) {
      setConnectError(e.message || 'Could not connect');
    } finally {
      setConnecting(false);
    }
  };

  const dev = streams?.device;
  const deviceName = chosen?.name || [dev?.Manufacturer, dev?.Model].filter(Boolean).join(' ') || `Camera ${chosen?.host ?? ''}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btn.secondary} disabled={scanning} onClick={scan}>
          {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radar className="w-4 h-4" />}
          {scanning ? 'Scanning the network…' : 'Scan again'}
        </button>
        <p className="text-[12.5px] text-slate-500">Finds cameras and recorders that support ONVIF. Some cameras need ONVIF turned on in their own settings first.</p>
      </div>
      {scanError && <Notice tone="error">{scanError}</Notice>}
      {found && (
        <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-inset ring-slate-200">
          {found.length === 0 && <li className="px-3.5 py-3 text-[13px] text-slate-500">No ONVIF cameras answered. Enter the camera's IP address below instead.</li>}
          {found.map((d) => {
            const selected = chosen?.host === d.host;
            return (
              <li key={d.host} className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3 ${selected ? 'bg-blue-50/50' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-slate-900 truncate">
                    {d.name || [d.manufacturer, d.hardware].filter(Boolean).join(' ') || 'IP camera'}
                    {d.isRecorder && <span className="ml-2 text-[11.5px] font-normal text-slate-500">recorder</span>}
                  </p>
                  <p className="text-[12px] text-slate-500 font-mono">
                    {d.host}
                    {d.port !== 80 ? `:${d.port}` : ''}
                    <span className="font-sans">{[d.manufacturer, d.hardware].filter(Boolean).length ? ` · ${[d.manufacturer, d.hardware].filter(Boolean).join(' ')}` : ''}</span>
                  </p>
                  {!d.cameraId && d.sameModelAs && (
                    <p className="mt-1 text-[12px] text-amber-800">
                      Probably “{d.sameModelAs}”, already added through the EZVIZ cloud. Adding it here as well would watch it twice. To switch it to a direct
                      connection, add it here, then remove the cloud one.
                    </p>
                  )}
                </div>
                {d.cameraId ? (
                  <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-slate-500">
                    <Check className="w-4 h-4" /> Added
                  </span>
                ) : (
                  <button type="button" className={selected ? btn.primary : btn.secondary} onClick={() => choose(d)}>
                    {selected ? 'Selected' : 'Choose'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <details className="max-w-2xl">
        <summary className="cursor-pointer text-[12.5px] font-medium text-slate-600 hover:text-slate-900">Not in the list? Enter its IP address</summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field id="onvif-host" label="IP address">
            <input id="onvif-host" value={manualHost} onChange={(e) => setManualHost(e.target.value)} spellCheck={false} placeholder="192.168.1.64" className={`${inputBase} w-48 font-mono`} />
          </Field>
          <Field id="onvif-port" label="ONVIF port">
            <input id="onvif-port" value={manualPort} onChange={(e) => setManualPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${inputBase} w-24 tabular-nums`} />
          </Field>
          <button type="button" className={btn.secondary} disabled={!manualHost.trim()} onClick={() => choose({ host: manualHost.trim(), port: Number(manualPort) || 80 })}>
            Use this camera
          </button>
        </div>
      </details>

      {chosen && (
        <div className="space-y-4 border-t border-slate-100 pt-4">
          <p className="text-[13px] text-slate-700">
            Sign in to <span className="font-medium">{chosen.name || chosen.host}</span> with the camera's own username and password.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
            <Field id="onvif-user" label="Username">
              <input id="onvif-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} className={`${inputBase} w-full`} />
            </Field>
            <Field id="onvif-pass" label="Password" help="Stored encrypted.">
              <input id="onvif-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={`${inputBase} w-full`} />
            </Field>
          </div>
          <button type="button" className={btn.primary} disabled={connecting || testing} onClick={connect}>
            {connecting || testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
            {connecting ? 'Reading the camera…' : testing ? 'Getting a picture…' : 'Connect'}
          </button>
          {connectError && <Notice tone="error">{connectError}</Notice>}
          {streams && (
            <div className="text-[13px] text-slate-700 space-y-1">
              <p>
                {[dev?.Manufacturer, dev?.Model].filter(Boolean).join(' ') || 'Camera'}
                {dev?.FirmwareVersion ? <span className="text-slate-500"> · firmware {dev.FirmwareVersion}</span> : null}
              </p>
              <ul className="text-[12.5px] text-slate-500">
                {streams.lenses.map((l) => (
                  <li key={l.channelNo}>
                    {streams.lenses.length > 1 ? `${l.channelName}: ` : 'Video: '}
                    {l.width && l.height ? `${l.width} × ${l.height}` : 'size unknown'}
                    {l.encoding ? ` ${l.encoding}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {streams && (
            <FinishAdd
              test={test}
              defaultName={deviceName}
              onAdd={(name, location) =>
                addAndReport(
                  {
                    connectionType: 'RTSP',
                    brand: 'custom',
                    username: username.trim(),
                    password,
                    channels: streams.lenses.map((l) => ({ channelNo: l.channelNo, channelName: l.channelName, streamUrl: l.streamUrl })),
                    serialNumber: dev?.SerialNumber || undefined,
                    model: [dev?.Manufacturer, dev?.Model].filter(Boolean).join(' ') || undefined,
                    firmware: dev?.FirmwareVersion || undefined,
                    name,
                    location,
                    tested: !!test?.ok,
                  },
                  props
                )
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- adding: USB, link, EZVIZ

function UsbForm(props: AddProps) {
  const [index, setIndex] = useState('0');
  const { test, testing, run, reset } = useTest();
  return (
    <div className="space-y-4">
      <Field id="usb-index" label="Camera" help="The camera must be plugged into the computer that runs WorkSight's AI service.">
        <select
          id="usb-index"
          value={index}
          onChange={(e) => {
            setIndex(e.target.value);
            reset();
          }}
          className={`${inputBase} w-full sm:w-80 pr-8`}
        >
          {[0, 1, 2, 3].map((i) => (
            <option key={i} value={i}>
              {i === 0 ? 'Camera 1 (usually the built-in one)' : `Camera ${i + 1}`}
            </option>
          ))}
        </select>
      </Field>
      <TestButton testing={testing} onClick={() => run({ connectionType: 'USB', streamUrl: `usb:${index}` })} />
      <FinishAdd
        test={test}
        defaultName={`USB camera ${Number(index) + 1}`}
        onAdd={(name, location) =>
          addAndReport({ connectionType: 'USB', channels: [{ streamUrl: `usb:${index}`, channelName: 'Main view' }], name, location, tested: !!test?.ok }, props)
        }
      />
    </div>
  );
}

function LinkForm(props: AddProps) {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { test, testing, run } = useTest();
  const conn = (): CameraConnection => ({ connectionType: 'HTTP', streamUrl: url.trim(), username: username.trim() || undefined, password: password || undefined });
  let host = '';
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    /* not a full address yet */
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Field id="link-url" label="Web address" className="sm:col-span-2" help="A snapshot picture (JPEG), an MJPEG stream, or an HLS stream (.m3u8).">
          <input id="link-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} placeholder="http://192.168.1.70/snapshot.jpg" className={`${inputBase} w-full font-mono`} />
        </Field>
        <Field id="link-user" label="Username" optional>
          <input id="link-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} className={`${inputBase} w-full`} />
        </Field>
        <Field id="link-pass" label="Password" optional>
          <input id="link-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={`${inputBase} w-full`} />
        </Field>
      </div>
      <TestButton testing={testing} disabled={!/^https?:\/\/.+/i.test(url.trim())} onClick={() => run(conn())} />
      <FinishAdd
        test={test}
        defaultName={host ? `Camera (${host})` : 'Web camera'}
        onAdd={(name, location) => addAndReport({ ...conn(), channels: [{ streamUrl: url.trim(), channelName: 'Main view' }], name, location, tested: !!test?.ok }, props)}
      />
    </div>
  );
}

function EzvizForm({ accountReady, goToAccount, ...props }: AddProps & { accountReady: boolean; goToAccount: () => void }) {
  const [found, setFound] = useState<DiscoveredCamera[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const find = useCallback(async () => {
    setFinding(true);
    setError(null);
    try {
      const res = await settingsApi.discoverCameras();
      setFound(res.data);
    } catch (e: any) {
      setError(e.message || 'Could not reach the camera account');
    } finally {
      setFinding(false);
    }
  }, []);

  useEffect(() => {
    if (accountReady) find();
  }, [accountReady, find]);

  if (!accountReady)
    return (
      <Notice tone="info">
        Connect your EZVIZ account first.{' '}
        <button type="button" onClick={goToAccount} className="font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2">
          Set up the camera account
        </button>
      </Notice>
    );
  return (
    <div className="space-y-3">
      <button type="button" className={btn.secondary} disabled={finding} onClick={find}>
        {finding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        Search again
      </button>
      {error && <Notice tone="error">{error}</Notice>}
      {found && found.length === 0 && <p className="text-[13px] text-slate-500">No cameras on this EZVIZ account yet. Add one in the EZVIZ app, then search again.</p>}
      {found && found.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-inset ring-slate-200">
          {found.map((d) => (
            <li key={d.serialNumber} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-slate-900 truncate">{d.name}</p>
                <p className="text-[12px] text-slate-500 font-mono">
                  {[d.model, d.serialNumber].filter(Boolean).join(' · ')}
                  <span className="font-sans">
                    {' · '}
                    {d.channels.length || 1} lens{(d.channels.length || 1) === 1 ? '' : 'es'}
                  </span>
                </p>
              </div>
              <StatusText tone={d.online ? 'emerald' : 'rose'}>{d.online ? 'Online' : 'Offline'}</StatusText>
              {d.cameraId ? (
                <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-slate-500">
                  <Check className="w-4 h-4" /> Added
                </span>
              ) : (
                <button
                  type="button"
                  className={btn.primary}
                  disabled={adding !== null}
                  onClick={async () => {
                    setAdding(d.serialNumber);
                    await addAndReport({ connectionType: 'EZVIZ', serialNumber: d.serialNumber }, props);
                    setAdding(null);
                    find();
                  }}
                >
                  {adding === d.serialNumber ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- adding: method picker

type Method = 'scan' | 'ip' | 'ezviz' | 'usb' | 'link';

const METHODS: { id: Method; icon: LucideIcon; title: string; text: string }[] = [
  { id: 'scan', icon: Radar, title: 'Find on this network', text: 'Most IP cameras and recorders (ONVIF). Nothing to type but the login.' },
  { id: 'ip', icon: Cctv, title: 'IP camera or recorder', text: 'Hikvision, Dahua, Uniview, Reolink, TP-Link, Axis, or any RTSP address.' },
  { id: 'ezviz', icon: Cloud, title: 'EZVIZ cloud account', text: 'Cameras added to your EZVIZ app account.' },
  { id: 'usb', icon: Usb, title: 'USB or built-in camera', text: 'A webcam plugged into the computer running WorkSight.' },
  { id: 'link', icon: Link2, title: 'Picture or stream link', text: 'A snapshot (JPEG), MJPEG or HLS (.m3u8) web address.' },
];

function AddCamera({ accountReady, goToAccount, onAdded, notify }: AddProps & { accountReady: boolean; goToAccount: () => void }) {
  const [method, setMethod] = useState<Method | null>(null);
  const current = METHODS.find((m) => m.id === method);
  const done = (c: CameraRecord) => {
    onAdded(c);
    if (method !== 'ezviz') setMethod(null);
  };
  return (
    <Card>
      <CardHeader
        title={current ? current.title : 'Add a camera'}
        description={current ? current.text : 'Choose how the camera connects.'}
        action={
          current ? (
            <button type="button" className={btn.ghost} onClick={() => setMethod(null)}>
              <ArrowLeft className="w-4 h-4" /> All ways
            </button>
          ) : undefined
        }
      />
      <div className="px-5 pb-5">
        {!method ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {METHODS.map((m) => {
              const Icon = m.icon;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setMethod(m.id)}
                    className="h-full w-full text-left rounded-xl p-4 ring-1 ring-inset ring-slate-200 hover:ring-slate-300 hover:bg-slate-50/60 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                  >
                    <span className="flex items-center gap-2.5">
                      <span className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
                        <Icon className="w-4 h-4" />
                      </span>
                      <span className="text-[13.5px] font-medium text-slate-900">{m.title}</span>
                    </span>
                    <span className="mt-2 block text-[12.5px] text-slate-500">{m.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : method === 'scan' ? (
          <NetworkScanForm onAdded={done} notify={notify} />
        ) : method === 'ip' ? (
          <IpCameraForm onAdded={done} notify={notify} />
        ) : method === 'ezviz' ? (
          <EzvizForm onAdded={done} notify={notify} accountReady={accountReady} goToAccount={goToAccount} />
        ) : method === 'usb' ? (
          <UsbForm onAdded={done} notify={notify} />
        ) : (
          <LinkForm onAdded={done} notify={notify} />
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- editing one camera

function CameraEditor({
  cam,
  status,
  canEdit,
  onChanged,
  onRemoved,
  notify,
}: {
  cam: CameraRecord;
  status: RecognitionStatus | null;
  canEdit: boolean;
  onChanged: (c: CameraRecord) => void;
  onRemoved: (id: string) => void;
  notify: Notify;
}) {
  const other = cam.connectionType !== 'EZVIZ';
  const networked = other && cam.connectionType !== 'USB';
  const initial = useCallback(
    () => ({
      name: cam.name,
      location: cam.location ?? '',
      host: cam.host ?? '',
      port: cam.port ? String(cam.port) : '',
      username: cam.username ?? '',
      password: '',
      lenses: cam.channels.map((l) => ({ channelNo: l.channelNo, channelName: l.channelName, streamUrl: l.streamUrl ?? '' })),
    }),
    [cam]
  );
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showPicture, setShowPicture] = useState<number | null>(null);
  const [newLensUrl, setNewLensUrl] = useState<string | null>(null);

  useEffect(() => setD(initial()), [initial]);

  const orig = initial();
  const lensDirty = d.lenses.filter((l) => {
    const o = orig.lenses.find((x) => x.channelNo === l.channelNo);
    return !o || o.channelName !== l.channelName.trim() || (other && o.streamUrl !== l.streamUrl.trim());
  });
  const connDirty = networked && (d.host.trim() !== orig.host || d.port !== orig.port || d.username.trim() !== orig.username || d.password !== '');
  const dirty = d.name.trim() !== orig.name || d.location.trim() !== orig.location || lensDirty.length > 0 || connDirty;
  const invalid = !d.name.trim() || d.lenses.some((l) => !l.channelName.trim() || (other && !l.streamUrl.trim()));

  const update = async (changes: CameraChanges, key: string, message: string) => {
    setBusy(key);
    try {
      const res = await settingsApi.updateCamera(cam.id, changes);
      onChanged(res.data);
      notify(message);
    } catch (e: any) {
      notify(e.message || 'Could not save the camera', 'error');
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    const changes: CameraChanges = { name: d.name.trim(), location: d.location.trim() || null };
    if (connDirty) {
      if (d.host.trim() !== orig.host || d.port !== orig.port) {
        changes.host = d.host.trim();
        changes.port = d.port ? Number(d.port) : null;
      }
      if (d.username.trim() !== orig.username) changes.username = d.username.trim() || null;
      if (d.password) changes.password = d.password;
    }
    // When the address changes, the server moves every lens to it; don't also send the old lens addresses.
    const movedAddress = changes.host !== undefined;
    if (lensDirty.length)
      changes.channels = lensDirty.map((l) => ({
        channelNo: l.channelNo,
        channelName: l.channelName.trim(),
        ...(other && !movedAddress && l.streamUrl.trim() !== orig.lenses.find((x) => x.channelNo === l.channelNo)?.streamUrl ? { streamUrl: l.streamUrl.trim() } : {}),
      }));
    update(changes, 'save', 'Camera saved.');
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await settingsApi.removeCamera(cam.id);
      onRemoved(cam.id);
      notify(`${cam.name} removed.`);
    } catch (e: any) {
      notify(e.message || 'Could not remove the camera', 'error');
      setBusy(null);
    }
  };

  const state = cameraState(cam, status);
  const canAddLens = cam.connectionType === 'RTSP';
  const templated = cam.connectionType === 'RTSP' && !!cam.brand && cam.brand !== 'custom';

  return (
    <div className="px-5 sm:px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-[14px] font-semibold text-slate-900 truncate">{cam.name}</h3>
            <StatusText tone={state.tone}>{state.text}</StatusText>
          </div>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {TYPE_LABEL[cam.connectionType] ?? cam.connectionType}
            <span className="font-mono">
              {' · '}
              {[cam.model, cam.connectionType === 'EZVIZ' ? cam.serialNumber : cam.host, cam.firmwareVer].filter(Boolean).join(' · ')}
            </span>
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={btn.secondary}
              disabled={!!busy}
              onClick={() => update({ isEnabled: !cam.isEnabled }, 'power', cam.isEnabled ? `${cam.name} turned off.` : `${cam.name} turned on. Recognition starts within 30 seconds.`)}
            >
              {busy === 'power' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Power className="w-4 h-4" />}
              {cam.isEnabled ? 'Turn off' : 'Turn on'}
            </button>
            <button type="button" className={btn.secondary} disabled={!!busy} onClick={() => setConfirmRemove(true)} aria-label={`Remove ${cam.name}`}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {confirmRemove && (
        <div className="mt-4 rounded-xl ring-1 ring-inset ring-rose-200 bg-rose-50/60 p-4">
          <p className="text-[13px] font-medium text-rose-900">Remove {cam.name}?</p>
          <p className="mt-1 text-[12.5px] text-rose-800">
            Its rooms, door lines and room-tracking history are deleted too. Attendance and sightings are kept. To pause it instead, use Turn off.
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" className={btn.secondary} disabled={busy === 'remove'} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy === 'remove'}
              onClick={remove}
              className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-rose-600 text-white text-[13px] font-medium shadow-sm hover:bg-rose-700 disabled:opacity-50"
            >
              {busy === 'remove' && <Loader2 className="w-4 h-4 animate-spin" />}
              Remove camera
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Field id={`cam-name-${cam.id}`} label="Name">
          <input id={`cam-name-${cam.id}`} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} disabled={!canEdit || !!busy} className={`${inputBase} w-full`} />
        </Field>
        <Field id={`cam-loc-${cam.id}`} label="Where it is" optional>
          <input
            id={`cam-loc-${cam.id}`}
            value={d.location}
            onChange={(e) => setD({ ...d, location: e.target.value })}
            disabled={!canEdit || !!busy}
            placeholder="e.g. Main hall, facing the door"
            className={`${inputBase} w-full`}
          />
        </Field>
        {networked && (
          <>
            <Field id={`cam-host-${cam.id}`} label="IP address" help="Changing it moves every lens to the new address.">
              <input id={`cam-host-${cam.id}`} value={d.host} onChange={(e) => setD({ ...d, host: e.target.value })} disabled={!canEdit || !!busy} spellCheck={false} className={`${inputBase} w-full font-mono`} />
            </Field>
            <Field id={`cam-port-${cam.id}`} label="Port">
              <input id={`cam-port-${cam.id}`} value={d.port} onChange={(e) => setD({ ...d, port: e.target.value.replace(/\D/g, '') })} disabled={!canEdit || !!busy} inputMode="numeric" className={`${inputBase} w-28 tabular-nums`} />
            </Field>
            <Field id={`cam-user-${cam.id}`} label="Username">
              <input id={`cam-user-${cam.id}`} value={d.username} onChange={(e) => setD({ ...d, username: e.target.value })} disabled={!canEdit || !!busy} autoComplete="off" spellCheck={false} className={`${inputBase} w-full`} />
            </Field>
            <Field id={`cam-pass-${cam.id}`} label="Password" help="Stored encrypted and never shown.">
              <input
                id={`cam-pass-${cam.id}`}
                type="password"
                value={d.password}
                onChange={(e) => setD({ ...d, password: e.target.value })}
                disabled={!canEdit || !!busy}
                autoComplete="new-password"
                placeholder={cam.hasPassword ? 'Saved. Type a new one to replace it' : ''}
                className={`${inputBase} w-full placeholder:text-[12.5px]`}
              />
            </Field>
          </>
        )}
      </div>

      <div className="mt-5">
        <p className="text-[13px] font-medium text-slate-700">{cam.channels.length > 1 ? 'Lenses and channels' : 'Lens'}</p>
        <ul className="mt-2 divide-y divide-slate-100 rounded-xl ring-1 ring-inset ring-slate-200">
          {cam.channels.map((lens) => {
            const draft = d.lenses.find((l) => l.channelNo === lens.channelNo);
            const ls = lensState(cam, lens, status);
            const setLens = (patch: Partial<{ channelName: string; streamUrl: string }>) =>
              setD({ ...d, lenses: d.lenses.map((l) => (l.channelNo === lens.channelNo ? { ...l, ...patch } : l)) });
            return (
              <li key={lens.channelNo} className="px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="text-[12px] font-medium text-slate-400 tabular-nums w-12 shrink-0">{cam.channels.length > 1 || cam.connectionType === 'EZVIZ' ? `Lens ${lens.channelNo}` : 'Lens'}</span>
                  <input
                    aria-label={`Name of lens ${lens.channelNo}`}
                    value={draft?.channelName ?? ''}
                    onChange={(e) => setLens({ channelName: e.target.value })}
                    disabled={!canEdit || !!busy}
                    className={`${inputBase} w-full sm:w-56`}
                  />
                  <div className="min-w-0 flex-1 flex">
                    <StatusText tone={ls.tone}>{ls.text}</StatusText>
                  </div>
                  <button type="button" className={btn.ghost} onClick={() => setShowPicture(showPicture === lens.channelNo ? null : lens.channelNo)} aria-label={`Picture from lens ${lens.channelNo}`}>
                    <Eye className="w-4 h-4" />
                  </button>
                  <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-slate-600">
                    Face recognition
                    <Switch
                      checked={lens.recognitionEnabled}
                      disabled={!canEdit || !!busy}
                      label={`Face recognition on lens ${lens.channelNo}`}
                      onChange={(v) =>
                        update(
                          { channels: [{ channelNo: lens.channelNo, recognitionEnabled: v }] },
                          `lens-${lens.channelNo}`,
                          v ? `Lens ${lens.channelNo}: recognition on. It starts within 30 seconds.` : `Lens ${lens.channelNo}: recognition off.`
                        )
                      }
                    />
                  </label>
                  {canEdit && other && cam.channels.length > 1 && (
                    <button
                      type="button"
                      className={btn.ghost}
                      disabled={!!busy}
                      aria-label={`Remove lens ${lens.channelNo}`}
                      onClick={() => update({ removeChannels: [lens.channelNo] }, `rm-${lens.channelNo}`, `Lens ${lens.channelNo} removed.`)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {other && cam.connectionType !== 'USB' && (
                  <div className="mt-2 sm:pl-16">
                    <input
                      aria-label={`Stream address of lens ${lens.channelNo}`}
                      value={draft?.streamUrl ?? ''}
                      onChange={(e) => setLens({ streamUrl: e.target.value })}
                      disabled={!canEdit || !!busy || templated}
                      title={templated ? 'Built from the brand and IP address' : undefined}
                      spellCheck={false}
                      className={`${inputBase} w-full h-8 text-[12px] font-mono`}
                    />
                  </div>
                )}
                {showPicture === lens.channelNo && <LensPicture cameraId={cam.id} channelNo={lens.channelNo} onClose={() => setShowPicture(null)} />}
              </li>
            );
          })}
          {canEdit && canAddLens && (
            <li className="px-3.5 py-3">
              {newLensUrl === null ? (
                <button
                  type="button"
                  className={btn.ghost}
                  disabled={!!busy}
                  onClick={() => (templated ? update({ addChannels: [{}] }, 'addlens', 'Channel added.') : setNewLensUrl(''))}
                >
                  {busy === 'addlens' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add a channel
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label="Stream address of the new channel"
                    value={newLensUrl}
                    onChange={(e) => setNewLensUrl(e.target.value)}
                    placeholder="rtsp://"
                    spellCheck={false}
                    className={`${inputBase} flex-1 min-w-[16rem] h-8 text-[12px] font-mono`}
                  />
                  <button
                    type="button"
                    className={btn.secondary}
                    disabled={!!busy || !newLensUrl.trim().toLowerCase().startsWith('rtsp')}
                    onClick={async () => {
                      await update({ addChannels: [{ streamUrl: newLensUrl.trim() }] }, 'addlens', 'Channel added.');
                      setNewLensUrl(null);
                    }}
                  >
                    Add
                  </button>
                  <button type="button" className={btn.ghost} onClick={() => setNewLensUrl(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </li>
          )}
        </ul>
      </div>

      {canEdit && dirty && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" className={btn.primary} disabled={!!busy || invalid} onClick={save}>
            {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
            Save changes
          </button>
          <button type="button" className={btn.secondary} disabled={!!busy} onClick={() => setD(initial())}>
            Discard
          </button>
          {invalid && <span className="text-[12px] text-rose-600">Names and addresses can’t be empty</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the tab

export function CamerasTab({
  canEdit,
  accountReady,
  status,
  notify,
  goToAccount,
}: {
  canEdit: boolean;
  accountReady: boolean;
  status: RecognitionStatus | null;
  notify: Notify;
  goToAccount: () => void;
}) {
  const [cameras, setCameras] = useState<CameraRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await settingsApi.cameras();
      setCameras(res.data);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e.message || 'Could not load cameras');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      if (cameras?.some((c) => c.connectionType === 'EZVIZ')) await settingsApi.refreshCameras();
      await load();
      notify('Camera status refreshed.');
    } catch (e: any) {
      notify(e.message || 'Could not refresh', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Your cameras"
          description="Turn lenses on or off for face recognition. Changes reach the AI service within 30 seconds."
          action={
            canEdit && cameras && cameras.length > 0 ? (
              <button type="button" className={btn.secondary} disabled={refreshing} onClick={refresh}>
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh status
              </button>
            ) : undefined
          }
        />
        {loadError ? (
          <div className="px-5 pb-5">
            <Notice tone="error">{loadError}</Notice>
          </div>
        ) : cameras === null ? (
          <div className="px-5 pb-5 space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : cameras.length === 0 ? (
          <EmptyState icon={Cctv} title="No cameras yet" description="Add one below. Any IP camera, recorder, USB webcam or EZVIZ camera works." />
        ) : (
          <div className="divide-y divide-slate-100 border-t border-slate-100">
            {cameras.map((c) => (
              <CameraEditor
                key={c.id}
                cam={c}
                status={status}
                canEdit={canEdit}
                notify={notify}
                onChanged={(u) => setCameras((cs) => cs?.map((x) => (x.id === u.id ? u : x)) ?? null)}
                onRemoved={(id) => setCameras((cs) => cs?.filter((x) => x.id !== id) ?? null)}
              />
            ))}
          </div>
        )}
      </Card>

      {canEdit && (
        <AddCamera
          accountReady={accountReady}
          goToAccount={goToAccount}
          notify={notify}
          onAdded={(c) => setCameras((cs) => [c, ...(cs ?? []).filter((x) => x.id !== c.id)])}
        />
      )}
    </div>
  );
}
