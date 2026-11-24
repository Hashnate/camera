'use client';

/**
 * Enrol from the office camera. The operator picks a lens and clicks the employee's face once; the scanner
 * then follows that face in the live picture and captures a sample only when it is a full view (big enough,
 * sharp, well lit, facing the camera, entirely in the picture). Captures that look like another enrolled
 * person, or repeat one already taken, are refused. Nothing is enrolled until the operator reviews the
 * samples, confirms consent and saves.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, Pause, Play, ScanFace as ScanIcon, Trash2, X } from 'lucide-react';
import { api, LensScan, ScanFace } from '@/lib/api';
import { btn } from '@/components/ui';

const TARGET_SAMPLES = 5;
const POLL_MS = 600; // pause between scans (each scan analyses one fresh frame)
const CAPTURE_EVERY_MS = 2500; // spacing between captures, for variety
const LOST_AFTER_MS = 6000;

type Lens = { cameraId: string; channelNo: number; label: string };
type Sample = { token: string; crop: string; pose: ScanFace['pose']; ownSimilarity: number | null };
type Note = { tone: 'ok' | 'warn' | 'info'; text: string } | null;

const CHECKS: { label: string; codes: string[] }[] = [
  { label: 'Close enough', codes: ['TOO_FAR'] },
  { label: 'Facing the camera', codes: ['TURNED_AWAY', 'TILTED'] },
  { label: 'Sharp', codes: ['BLURRY', 'UNCLEAR'] },
  { label: 'Good light', codes: ['TOO_DARK', 'TOO_BRIGHT'] },
  { label: 'Fully in the picture', codes: ['CUT_OFF'] },
];

const POSE_LABEL: Record<string, string> = { FRONT: 'Front', LEFT: 'Turned left', RIGHT: 'Turned right', DOWN: 'Looking down' };

const center = (b: ScanFace['box']) => ({ x: b[0] + b[2] / 2, y: b[1] + b[3] / 2, w: b[2] });

export function CameraScanEnroll({
  employee,
  onClose,
  onSaved,
}: {
  employee: { id: string; fullName: string; employeeCode: string };
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const firstName = employee.fullName.split(' ')[0];
  const [lenses, setLenses] = useState<Lens[] | null>(null);
  const [lens, setLens] = useState<Lens | null>(null);
  const [scan, setScan] = useState<LensScan | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The face being followed: its last centre in the picture (fractions), and when it was last found.
  const lockRef = useRef<{ x: number; y: number; w: number; seenAt: number } | null>(null);
  const [lockedIndex, setLockedIndex] = useState<number | null>(null);
  const [lost, setLost] = useState(false);
  const capturingRef = useRef(false);
  const lastCaptureRef = useRef(0);
  const samplesRef = useRef<Sample[]>([]);
  samplesRef.current = samples;

  // Lenses that recognition watches (only those have live frames).
  useEffect(() => {
    api
      .getCameras()
      .then((res) => {
        const out: Lens[] = [];
        for (const cam of res.data || []) {
          for (const ch of cam.channels || []) {
            if (ch.recognitionEnabled === false) continue;
            out.push({ cameraId: cam.id, channelNo: ch.channelNo, label: `${ch.channelName || `Lens ${ch.channelNo}`} · ${cam.name}` });
          }
        }
        setLenses(out);
        setLens((cur) => cur ?? out[out.length - 1] ?? null); // the last lens is usually the close-up one
      })
      .catch((e: any) => setScanError(e.message || 'Could not load cameras'));
  }, []);

  const resetLock = () => {
    lockRef.current = null;
    setLockedIndex(null);
    setLost(false);
  };

  const tryCapture = useCallback(
    async (s: LensScan, face: ScanFace) => {
      capturingRef.current = true;
      lastCaptureRef.current = Date.now();
      try {
        const res = await api.scanCapture(employee.id, { cameraId: s.cameraId, channelNo: s.channelNo, scanId: s.scanId, faceIndex: face.index });
        if (res.status === 'ACCEPTED') {
          const next = [...samplesRef.current, { token: res.token, crop: res.crop, pose: res.pose, ownSimilarity: res.ownSimilarity }];
          setSamples(next);
          setNote({ tone: 'ok', text: `Captured sample ${next.length}${res.pose ? ` (${POSE_LABEL[res.pose] ?? res.pose})` : ''}.` });
          if (next.length >= TARGET_SAMPLES) {
            setRunning(false);
            setNote({ tone: 'ok', text: `${TARGET_SAMPLES} samples captured. Review them and save.` });
          }
        } else if (res.status === 'OTHER_PERSON') {
          setNote({ tone: 'warn', text: `${res.message} Check you clicked ${firstName}'s face.` });
        } else if (res.status === 'DUPLICATE') {
          setNote({ tone: 'info', text: `Same as a sample already taken. Waiting for a slightly different angle.` });
        } else if (res.status === 'LIMIT') {
          setRunning(false);
          setNote({ tone: 'warn', text: res.message });
        }
        // NOT_FULL_VIEW / EXPIRED: the next scan simply tries again.
      } catch (e: any) {
        setNote({ tone: 'warn', text: e.message || 'Capture failed' });
      } finally {
        capturingRef.current = false;
      }
    },
    [employee.id, firstName]
  );

  // Handle each new scan: follow the locked face, and capture when it is a full view.
  const onScan = useCallback(
    (s: LensScan) => {
      setScan(s);
      const lock = lockRef.current;
      if (!lock) return;
      let best: ScanFace | null = null;
      let bestD = Infinity;
      for (const f of s.faces) {
        const c = center(f.box);
        const d = Math.hypot(c.x - lock.x, (c.y - lock.y) * (s.height / s.width));
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      if (best && bestD <= Math.max(0.04, lock.w * 0.9)) {
        const c = center(best.box);
        lockRef.current = { x: c.x, y: c.y, w: c.w, seenAt: Date.now() };
        setLockedIndex(best.index);
        setLost(false);
        if (
          best.fullView &&
          !capturingRef.current &&
          samplesRef.current.length < TARGET_SAMPLES &&
          Date.now() - lastCaptureRef.current >= CAPTURE_EVERY_MS
        ) {
          tryCapture(s, best);
        }
      } else {
        setLockedIndex(null);
        if (Date.now() - lock.seenAt > LOST_AFTER_MS) setLost(true);
      }
    },
    [tryCapture]
  );

  // Scan loop: one request at a time, a short pause between.
  useEffect(() => {
    if (!lens || !running) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await api.scanLens(lens.cameraId, lens.channelNo);
        if (!alive) return;
        setScanError(null);
        onScan(res.data);
      } catch (e: any) {
        if (alive) setScanError(e.message || 'No picture from this lens');
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [lens, running, onScan]);

  const lockOn = (f: ScanFace) => {
    const c = center(f.box);
    lockRef.current = { x: c.x, y: c.y, w: c.w, seenAt: Date.now() };
    setLockedIndex(f.index);
    setLost(false);
    lastCaptureRef.current = 0;
    setNote({ tone: 'info', text: `Following this face. Samples are taken automatically when it's a full view.` });
    if (!running && samples.length < TARGET_SAMPLES) setRunning(true);
  };

  const lockedFace = scan && lockedIndex !== null ? scan.faces.find((f) => f.index === lockedIndex) ?? null : null;
  const poses = useMemo(() => new Set(samples.map((s) => s.pose)), [samples]);
  const missingPose = (['FRONT', 'LEFT', 'RIGHT'] as const).find((p) => !poses.has(p));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.scanSave(employee.id, samples.map((s) => s.token));
      onSaved(res.message);
    } catch (e: any) {
      setSaveError(e.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------------ render

  let status: React.ReactNode;
  if (scanError) status = <span className="text-rose-700">{scanError}</span>;
  else if (!scan) status = 'Connecting to the camera…';
  else if (!lockRef.current) status = <>Click <b className="font-semibold">{firstName}&apos;s</b> face in the picture to start.</>;
  else if (lost) status = <span className="text-amber-800">Lost {firstName}. Click their face again.</span>;
  else if (samples.length >= TARGET_SAMPLES) status = <span className="text-emerald-700">Done. Review the samples and save.</span>;
  else if (!running) status = 'Paused.';
  else if (lockedFace?.fullView) status = <span className="text-emerald-700">Full view, capturing…</span>;
  else if (lockedFace) status = <span className="text-amber-800">Waiting for a full view: {lockedFace.issues.map((i) => i.text.toLowerCase()).join(', ')}.</span>;
  else status = `Looking for ${firstName}…`;

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Scan from office camera">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[95vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
              <ScanIcon className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-slate-900 truncate">Scan from office camera · {employee.fullName}</h2>
              <p className="text-[12.5px] text-slate-500 truncate">Samples taken as the office camera sees them match far better than phone photos.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_330px] gap-5 p-4 sm:p-5">
          {/* Live picture */}
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-[12.5px] text-slate-500 min-w-0 max-w-full">
                Lens
                <select
                  value={lens ? `${lens.cameraId}:${lens.channelNo}` : ''}
                  onChange={(e) => {
                    setLens(lenses?.find((l) => `${l.cameraId}:${l.channelNo}` === e.target.value) ?? null);
                    setScan(null);
                    resetLock();
                  }}
                  className="h-9 min-w-0 max-w-full pl-2.5 pr-7 rounded-lg bg-white ring-1 ring-inset ring-slate-200 text-[13px] text-slate-700 border-0"
                >
                  {!lenses && <option>Loading…</option>}
                  {lenses?.map((l) => (
                    <option key={`${l.cameraId}:${l.channelNo}`} value={`${l.cameraId}:${l.channelNo}`}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => setRunning((r) => !r)} className={btn.secondary} disabled={!lens}>
                {running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />} {running ? 'Pause' : 'Resume'}
              </button>
            </div>

            <div className="relative rounded-xl overflow-hidden bg-slate-900 ring-1 ring-slate-200" style={{ aspectRatio: scan ? `${scan.width} / ${scan.height}` : '16 / 9' }}>
              {scan ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={scan.image} alt="Live picture from the office camera" className="absolute inset-0 w-full h-full object-contain select-none" draggable={false} />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-[13px] gap-2">
                  {scanError ? <AlertTriangle className="w-4 h-4 text-amber-400" /> : <Loader2 className="w-4 h-4 animate-spin" />}
                  {scanError ?? 'Connecting to the camera…'}
                </div>
              )}
              {scan?.faces.map((f) => {
                const locked = f.index === lockedIndex;
                const known = f.looksLike && f.looksLike.similarity >= 0.46 ? f.looksLike.name.split(' ')[0] : null;
                const tone = locked ? 'border-blue-500 ring-2 ring-blue-500/40' : f.fullView ? 'border-emerald-400' : 'border-amber-300 border-dashed';
                return (
                  <button
                    key={f.index}
                    type="button"
                    onClick={() => lockOn(f)}
                    className={`absolute border-2 rounded-md transition-[border-color] hover:border-white ${tone}`}
                    style={{ left: `${f.box[0] * 100}%`, top: `${f.box[1] * 100}%`, width: `${f.box[2] * 100}%`, height: `${f.box[3] * 100}%` }}
                    title={f.fullView ? 'Full view' : f.issues.map((i) => i.text).join(' · ')}
                    aria-label={`${locked ? employee.fullName : known ?? 'Face'}: ${f.fullView ? 'full view' : f.issues.map((i) => i.text).join(', ')}. Click to follow.`}
                  >
                    <span
                      className={`absolute left-0 -top-5 whitespace-nowrap rounded px-1 text-[10.5px] font-semibold leading-4 ${
                        locked ? 'bg-blue-600 text-white' : f.fullView ? 'bg-emerald-500 text-white' : 'bg-amber-300 text-amber-950'
                      }`}
                    >
                      {locked ? firstName : known ?? '?'}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-slate-500">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm border-2 border-blue-500" /> Following</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm border-2 border-emerald-400" /> Full view</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm border-2 border-dashed border-amber-300" /> Not a full view (hover for why)</span>
              <span>Labels show who a face already looks like.</span>
            </div>
          </div>

          {/* Side panel */}
          <div className="space-y-4">
            <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200/70 p-4">
              <p className="text-[13px] text-slate-700 leading-snug">{status}</p>
              {lockedFace && (
                <ul className="mt-3 space-y-1.5">
                  {CHECKS.map((c) => {
                    const failed = lockedFace.issues.some((i) => c.codes.includes(i.code));
                    return (
                      <li key={c.label} className={`flex items-center gap-2 text-[12.5px] ${failed ? 'text-amber-800' : 'text-slate-700'}`}>
                        <span className={`w-4 h-4 rounded-full flex items-center justify-center ${failed ? 'bg-amber-100' : 'bg-emerald-100 text-emerald-700'}`}>
                          {failed ? <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> : <Check className="w-3 h-3" />}
                        </span>
                        {c.label}
                      </li>
                    );
                  })}
                </ul>
              )}
              {note && (
                <p
                  className={`mt-3 text-[12px] rounded-lg px-2.5 py-1.5 ${
                    note.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : note.tone === 'warn' ? 'bg-amber-50 text-amber-900' : 'bg-white text-slate-600 ring-1 ring-slate-200'
                  }`}
                >
                  {note.text}
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[13px] font-semibold text-slate-900">Samples</p>
                <span className="text-[12px] text-slate-500 tabular-nums">
                  {samples.length} / {TARGET_SAMPLES}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-3">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(samples.length / TARGET_SAMPLES) * 100}%` }} />
              </div>
              {samples.length ? (
                <div className="grid grid-cols-3 gap-2">
                  {samples.map((s, i) => (
                    <div key={s.token} className="relative group rounded-lg overflow-hidden ring-1 ring-slate-200 bg-slate-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.crop} alt={`Sample ${i + 1}`} className="w-full aspect-square object-cover" />
                      <span className="absolute bottom-0 inset-x-0 bg-slate-900/60 text-white text-[10px] px-1 py-0.5 truncate">{s.pose ? POSE_LABEL[s.pose] ?? s.pose : 'Sample'}</span>
                      <button
                        type="button"
                        onClick={() => setSamples((cur) => cur.filter((x) => x.token !== s.token))}
                        className="absolute top-1 right-1 p-1 rounded-md bg-white/90 text-rose-600 opacity-0 group-hover:opacity-100 focus:opacity-100"
                        aria-label={`Remove sample ${i + 1}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-slate-500">Captured faces appear here for you to check before saving.</p>
              )}
              {samples.length > 0 && samples.length < TARGET_SAMPLES && missingPose && (
                <p className="mt-2 text-[11.5px] text-slate-500">
                  Tip: a sample {missingPose === 'FRONT' ? 'facing the camera' : missingPose === 'LEFT' ? 'turned slightly left' : 'turned slightly right'} would add variety.
                </p>
              )}
            </div>

            <div className="rounded-xl ring-1 ring-slate-200 p-3.5 space-y-3">
              <label className="flex items-start gap-2 text-[12.5px] text-slate-700">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 rounded border-slate-300" />
                <span>{employee.fullName} has consented to face recognition, and these samples show only them.</span>
              </label>
              {saveError && <p className="text-[12px] text-rose-700">{saveError}</p>}
              <button type="button" onClick={save} disabled={!consent || !samples.length || saving} className={`${btn.primary} w-full`}>
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Save {samples.length || ''} sample{samples.length === 1 ? '' : 's'}
              </button>
              <p className="text-[11.5px] text-slate-500">
                Saved samples are added to {firstName}&apos;s face data; the oldest are replaced once the per-person limit is reached. Only the face
                signature is stored, never the picture.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
