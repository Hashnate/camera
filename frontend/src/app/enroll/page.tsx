'use client';

/**
 * Phone self-enrolment, opened from the one-time QR code HR shows on the dashboard.
 * No login: the token in the URL is the only credential. All calls go to /api/public/enroll/*,
 * which this Next server forwards to the backend, so the phone never needs the backend's port.
 *
 * Camera: browsers only allow the live camera (getUserMedia) on HTTPS or localhost. On the office
 * Wi-Fi the page is plain http://192.168.x.x, so it falls back to <input capture="user">, which
 * opens the phone's own selfie camera and works everywhere.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Video,
  Camera,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Clock,
  ArrowLeft,
  ArrowRight,
  Sun,
  Glasses,
  Smartphone,
} from 'lucide-react';

type StepKey = 'front' | 'left' | 'right';
type Phase = 'loading' | 'error' | 'intro' | 'capture' | 'review' | 'submitting' | 'done';

interface StepDef {
  key: StepKey;
  label: string;
  title: string;
  hint: string;
  expected: 'FRONT' | 'LEFT' | 'RIGHT';
}

const STEPS: StepDef[] = [
  {
    key: 'front',
    label: 'Straight',
    title: 'Look straight at the camera',
    hint: 'Hold the phone at eye level, about an arm’s length away. Keep a neutral expression.',
    expected: 'FRONT',
  },
  {
    key: 'left',
    label: 'Left',
    title: 'Turn your head slightly left',
    hint: 'Turn your head a little to your left, about a quarter turn. Keep your whole face in the photo.',
    expected: 'LEFT',
  },
  {
    key: 'right',
    label: 'Right',
    title: 'Turn your head slightly right',
    hint: 'Now turn a little to your right. Keep your whole face in the photo.',
    expected: 'RIGHT',
  },
];

interface Shot {
  blob: Blob;
  url: string;
  state: 'checking' | 'ok' | 'warn' | 'bad';
  message: string;
  detected: string | null;
  quality: number | null;
  canOverride: boolean;
}

interface Info {
  employee: { firstName: string; fullName: string; employeeCode: string };
  secondsRemaining: number;
}

interface ValidateData {
  valid: boolean;
  status: string;
  message: string;
  detectedAngle?: string;
  qualityScore?: number;
}

class EnrollError extends Error {
  constructor(message: string, public status: number, public code?: string, public angle?: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/public/enroll/${path}`, init);
  } catch {
    throw new EnrollError('Can’t reach the WorkSight server. Check that you are on the office Wi-Fi.', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new EnrollError(body.message || `Something went wrong (${res.status}).`, res.status, body.code, body.angle);
  }
  return body as T;
}

function drawToJpeg(src: CanvasImageSource, w: number, h: number, maxSide = 1280): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Could not process the photo.'));
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo.'))), 'image/jpeg', 0.9)
  );
}

/** Shrink a camera photo (often 12 MP) to a ~1280px JPEG; also applies EXIF rotation and drops metadata. */
async function fileToJpeg(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await drawToJpeg(img, img.naturalWidth, img.naturalHeight);
  } catch {
    if (file.type === 'image/jpeg' || file.type === 'image/png') return file;
    throw new Error('This photo format isn’t supported. Please take the photo again.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function judge(step: StepKey, data: ValidateData | null, leftDetected: string | null): Omit<Shot, 'blob' | 'url'> {
  if (!data) {
    return {
      state: 'warn',
      message: 'We couldn’t check this photo right now. You can retake it or use it anyway.',
      detected: null,
      quality: null,
      canOverride: true,
    };
  }
  const quality = data.qualityScore !== undefined ? Math.round(data.qualityScore * 100) : null;
  if (!data.valid) {
    return { state: 'bad', message: data.message || 'No clear face found. Please retake.', detected: null, quality, canOverride: false };
  }
  const detected = data.detectedAngle || null;
  const warn = (message: string) => ({ state: 'warn' as const, message, detected, quality, canOverride: true });

  if (step === 'front') {
    if (detected && detected !== 'FRONT') return warn('Your head looks turned. Face the camera straight on.');
  } else {
    if (detected === 'FRONT') return warn(`Turn your head a little more to your ${step}.`);
    // Some phones save selfies mirrored, so either side counts, as long as left and right differ.
    if (step === 'right' && leftDetected && leftDetected !== 'FRONT' && detected === leftDetected) {
      return warn('This looks like the same side as your left photo. Turn the other way.');
    }
  }
  return { state: 'ok', message: 'Looks good', detected, quality, canOverride: false };
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Simple head diagram; turned heads shift features toward the side they face (as seen in a selfie). */
function PoseIllustration({ dir, className = '' }: { dir: StepKey; className?: string }) {
  const dx = dir === 'left' ? -11 : dir === 'right' ? 11 : 0;
  return (
    <svg viewBox="0 0 120 150" className={className} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 148c4-22 20-32 38-32s34 10 38 32" opacity="0.5" />
      <ellipse cx="60" cy="62" rx="34" ry="44" />
      {dir !== 'front' && <path d={dir === 'left' ? 'M94 56c5 0 6 14 0 16' : 'M26 56c-5 0-6 14 0 16'} opacity="0.7" />}
      <circle cx={47 + dx} cy="56" r="3" fill="currentColor" stroke="none" />
      <circle cx={73 + dx} cy="56" r="3" fill="currentColor" stroke="none" />
      <path d={`M${60 + dx} 60 L${60 + dx * 1.7} 76 L${60 + dx * 0.4} 78`} />
      <path d={`M${50 + dx} 88 Q${60 + dx} 94 ${70 + dx} 88`} />
    </svg>
  );
}

function BrandHeader({ secondsLeft }: { secondsLeft: number | null }) {
  return (
    <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-slate-200">
      <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white">
            <Video className="w-4 h-4" />
          </div>
          <span className="font-bold text-slate-900 tracking-tight">WorkSight</span>
        </div>
        {secondsLeft !== null && (
          <span
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold tabular-nums border ${
              secondsLeft < 120 ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-slate-50 text-slate-600 border-slate-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5" /> {fmt(secondsLeft)}
          </span>
        )}
      </div>
    </header>
  );
}

function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-20 bg-white border-t border-slate-200 pb-[max(12px,env(safe-area-inset-bottom))]">
      <div className="max-w-md mx-auto px-4 pt-3 space-y-2">{children}</div>
    </div>
  );
}

const btnPrimary =
  'w-full h-12 rounded-xl bg-blue-600 text-white font-semibold text-[15px] inline-flex items-center justify-center gap-2 active:scale-[0.98] transition disabled:opacity-50 disabled:active:scale-100';
const btnSecondary =
  'w-full h-12 rounded-xl bg-white text-slate-700 border border-slate-300 font-semibold text-[15px] inline-flex items-center justify-center gap-2 active:bg-slate-50 transition disabled:opacity-50';

export default function EnrollPage() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState<{ title: string; message: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [shots, setShots] = useState<Partial<Record<StepKey, Shot>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const [liveSupported, setLiveSupported] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const step = STEPS[stepIndex];
  const shot = shots[step.key];
  const live = liveSupported && !liveError;
  const firstName = info?.employee.firstName || 'there';

  const fail = useCallback((err: unknown) => {
    const e = err instanceof EnrollError ? err : null;
    if (e && (e.status === 404 || e.status === 410)) {
      const title =
        e.code === 'COMPLETED'
          ? 'Already done'
          : e.code === 'SUBMITTED'
          ? 'Photos already sent'
          : e.code === 'EXPIRED'
          ? 'This link has expired'
          : 'This link can’t be used';
      setFatal({ title, message: e.message });
      setPhase('error');
      return true;
    }
    return false;
  }, []);

  // ---- open the link
  useEffect(() => {
    setLiveSupported(window.isSecureContext && !!navigator.mediaDevices?.getUserMedia);
    const t = new URLSearchParams(window.location.search).get('token') || '';
    setToken(t);
    if (!t) {
      setFatal({ title: 'Missing link details', message: 'Please scan the QR code shown by HR again.' });
      setPhase('error');
      return;
    }
    call<{ data: Info }>(encodeURIComponent(t))
      .then((res) => {
        setInfo(res.data);
        setDeadline(Date.now() + res.data.secondsRemaining * 1000);
        setPhase('intro');
      })
      .catch((err) => {
        if (!fail(err)) {
          setFatal({ title: 'Couldn’t open the link', message: (err as Error).message });
          setPhase('error');
        }
      });
  }, [fail]);

  // ---- countdown
  useEffect(() => {
    if (!deadline || phase === 'done' || phase === 'error') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadline, phase]);
  const secondsLeft = deadline && phase !== 'done' && phase !== 'error' ? Math.max(0, (deadline - now) / 1000) : null;
  useEffect(() => {
    if (secondsLeft === 0 && phase !== 'submitting') {
      setFatal({ title: 'This link has expired', message: 'Ask HR to show you a new QR code.' });
      setPhase('error');
    }
  }, [secondsLeft, phase]);

  // ---- live camera (HTTPS only): keep one stream for the whole capture phase
  const wantStream = phase === 'capture' && live;
  useEffect(() => {
    if (!wantStream) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        setStreamReady(true);
      })
      .catch((e) => {
        if (!cancelled) setLiveError(e?.name === 'NotAllowedError' ? 'Camera access was blocked.' : 'Could not start the camera.');
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStreamReady(false);
    };
  }, [wantStream]);

  useEffect(() => {
    const v = videoRef.current;
    if (v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      v.play().catch(() => {});
    }
  }, [streamReady, stepIndex, shot, phase]);

  // ---- release preview URLs on unmount
  useEffect(() => () => Object.values(shotsRef.current).forEach((s) => s && URL.revokeObjectURL(s.url)), []);

  const setShot = (key: StepKey, value: Shot | undefined) =>
    setShots((prev) => {
      const old = prev[key];
      if (old && old.url !== value?.url) URL.revokeObjectURL(old.url);
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });

  const checkShot = async (key: StepKey, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const pending: Shot = { blob, url, state: 'checking', message: 'Checking your photo…', detected: null, quality: null, canOverride: false };
    setShot(key, pending);
    setNotice(null);

    let data: ValidateData | null = null;
    try {
      const form = new FormData();
      form.append('image', blob, `${key}.jpg`);
      form.append('expected_angle', STEPS.find((s) => s.key === key)!.expected);
      const res = await call<{ success: boolean; data: ValidateData }>(`${encodeURIComponent(token)}/validate`, {
        method: 'POST',
        body: form,
      });
      // success:false still carries {valid:false, message} (e.g. no face found), which judge() reports.
      data = res.data ?? null;
    } catch (err) {
      if (fail(err)) return;
      data = null;
    }
    const leftDetected = key === 'right' ? shotsRef.current.left?.detected ?? null : null;
    setShots((prev) => (prev[key]?.url === url ? { ...prev, [key]: { ...pending, ...judge(key, data, leftDetected) } } : prev));
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      await checkShot(step.key, await fileToJpeg(file));
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const captureLive = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setBusy(true);
    try {
      await checkShot(step.key, await drawToJpeg(v, v.videoWidth, v.videoHeight));
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takePhoto = () => (live ? captureLive() : fileRef.current?.click());
  const retake = () => setShot(step.key, undefined);
  const accept = () => {
    if (shot) setShot(step.key, { ...shot, state: 'ok', message: 'Accepted', canOverride: false });
    goNext();
  };
  const goNext = () => {
    if (stepIndex < STEPS.length - 1) setStepIndex(stepIndex + 1);
    else setPhase('review');
  };

  const submit = async () => {
    setPhase('submitting');
    setNotice(null);
    try {
      const form = new FormData();
      form.append('consent', 'true');
      STEPS.forEach((s) => form.append(s.key, shots[s.key]!.blob, `${s.key}.jpg`));
      await call(`${encodeURIComponent(token)}/submit`, { method: 'POST', body: form });
      setPhase('done');
    } catch (err) {
      if (fail(err)) return;
      const e = err as EnrollError;
      const idx = STEPS.findIndex((s) => s.key === e.angle);
      if (idx >= 0) {
        setShot(STEPS[idx].key, undefined);
        setStepIndex(idx);
        setNotice(e.message);
        setPhase('capture');
      } else {
        setNotice(e.message);
        setPhase('review');
      }
    }
  };

  // ------------------------------------------------------------------ screens

  if (phase === 'loading') {
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col">
        <BrandHeader secondsLeft={null} />
        <div className="flex-1 flex items-center justify-center text-slate-500 gap-2 text-sm">
          <Loader2 className="w-5 h-5 animate-spin" /> Opening your enrolment link…
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col">
        <BrandHeader secondsLeft={null} />
        <main className="flex-1 max-w-md w-full mx-auto px-6 flex flex-col items-center justify-center text-center">
          <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center mb-4">
            {fatal?.title === 'Already done' || fatal?.title === 'Photos already sent' ? (
              <CheckCircle2 className="w-7 h-7 text-emerald-600" />
            ) : (
              <AlertTriangle className="w-7 h-7" />
            )}
          </div>
          <h1 className="text-xl font-bold text-slate-900">{fatal?.title}</h1>
          <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">{fatal?.message}</p>
        </main>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col">
        <BrandHeader secondsLeft={null} />
        <main className="flex-1 max-w-md w-full mx-auto px-6 flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-4">
            <CheckCircle2 className="w-9 h-9" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Photos sent, {firstName}!</h1>
          <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">
            HR will check them and save your enrolment. After that, the office cameras record your attendance automatically.
          </p>
          <div className="flex gap-2 mt-6">
            {STEPS.map((s) =>
              shots[s.key] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={s.key} src={shots[s.key]!.url} alt={`${s.label} photo`} className="w-16 h-20 rounded-xl object-cover border border-slate-200" />
              ) : null
            )}
          </div>
          <p className="text-sm text-slate-500 mt-6">You can close this page now.</p>
        </main>
      </div>
    );
  }

  if (phase === 'intro') {
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col">
        <BrandHeader secondsLeft={secondsLeft} />
        <main className="flex-1 max-w-md w-full mx-auto px-4 py-6 space-y-5">
          <div>
            <p className="text-sm font-semibold text-blue-600">Face enrolment</p>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">Hi {firstName} 👋</h1>
            <p className="text-[15px] text-slate-600 mt-2 leading-relaxed">
              Take three quick selfies so the office cameras can recognise you and record your attendance automatically.
              It takes about a minute.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {STEPS.map((s, i) => (
              <div key={s.key} className="bg-white border border-slate-200 rounded-2xl p-3 flex flex-col items-center text-center">
                <PoseIllustration dir={s.key} className="w-12 h-14 text-slate-700" />
                <span className="text-xs font-semibold text-slate-800 mt-1.5">
                  {i + 1}. {s.label}
                </span>
              </div>
            ))}
          </div>

          <ul className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100 text-sm text-slate-700">
            <li className="flex items-center gap-3 px-4 py-3">
              <Sun className="w-5 h-5 text-amber-500 shrink-0" /> Face a window or light, not with the light behind you
            </li>
            <li className="flex items-center gap-3 px-4 py-3">
              <Glasses className="w-5 h-5 text-slate-500 shrink-0" /> Remove sunglasses, caps and masks
            </li>
            <li className="flex items-center gap-3 px-4 py-3">
              <Smartphone className="w-5 h-5 text-blue-500 shrink-0" /> Use the front (selfie) camera
            </li>
          </ul>

          <label className="flex items-start gap-3 bg-blue-50/70 border border-blue-200 rounded-2xl p-4 cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 w-5 h-5 rounded border-slate-300 text-blue-600 shrink-0"
            />
            <span className="text-[13px] text-slate-700 leading-relaxed">
              I agree that WorkSight may create an <b>encrypted face template</b> from these photos to record my attendance,
              and keep the photos so HR can check the enrolment. I can ask HR to delete my face data at any time.
            </span>
          </label>
        </main>
        <ActionBar>
          <button type="button" disabled={!consent} onClick={() => setPhase('capture')} className={btnPrimary}>
            <Camera className="w-5 h-5" /> Start
          </button>
          {!consent && <p className="text-center text-xs text-slate-500">Tick the box above to continue.</p>}
        </ActionBar>
      </div>
    );
  }

  if (phase === 'review' || phase === 'submitting') {
    const submitting = phase === 'submitting';
    return (
      <div className="min-h-dvh bg-slate-50 flex flex-col">
        <BrandHeader secondsLeft={secondsLeft} />
        <main className="flex-1 max-w-md w-full mx-auto px-4 py-6 space-y-5">
          <div>
            <p className="text-sm font-semibold text-blue-600">Almost done</p>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">Check your photos</h1>
            <p className="text-[15px] text-slate-600 mt-2">Tap a photo to retake it.</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {STEPS.map((s, i) => {
              const sh = shots[s.key];
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setShot(s.key, undefined);
                    setStepIndex(i);
                    setPhase('capture');
                  }}
                  className="relative rounded-2xl overflow-hidden bg-slate-200 aspect-[3/4] border border-slate-200 disabled:opacity-60"
                >
                  {sh && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sh.url} alt={`${s.label} photo`} className="w-full h-full object-cover" />
                  )}
                  <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent text-white text-xs font-semibold py-1.5 flex items-center justify-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> {s.label}
                  </span>
                </button>
              );
            })}
          </div>
          {notice && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-800 flex gap-2">
              <XCircle className="w-5 h-5 shrink-0" /> {notice}
            </div>
          )}
          <div className="flex items-start gap-2 text-xs text-slate-500">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            Your face template is encrypted (AES-256) and only used for attendance at this office.
          </div>
        </main>
        <ActionBar>
          <button type="button" onClick={submit} disabled={submitting} className={btnPrimary}>
            {submitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Sending your photos…
              </>
            ) : (
              <>
                <ShieldCheck className="w-5 h-5" /> Send to HR
              </>
            )}
          </button>
        </ActionBar>
      </div>
    );
  }

  // ---- capture
  const checking = shot?.state === 'checking' || busy;
  return (
    <div className="min-h-dvh bg-slate-50 flex flex-col">
      <BrandHeader secondsLeft={secondsLeft} />
      <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden" onChange={onFile} />

      <main className="flex-1 max-w-md w-full mx-auto px-4 pt-4 pb-4 flex flex-col">
        {/* progress */}
        <div className="flex gap-1.5 mb-4" aria-label={`Step ${stepIndex + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex-1">
              <div
                className={`h-1.5 rounded-full ${
                  shots[s.key]?.state === 'ok' && i !== stepIndex ? 'bg-emerald-500' : i === stepIndex ? 'bg-blue-600' : 'bg-slate-200'
                }`}
              />
              <span className={`block text-[11px] mt-1 font-semibold ${i === stepIndex ? 'text-blue-700' : 'text-slate-400'}`}>{s.label}</span>
            </div>
          ))}
        </div>

        <p className="text-sm font-semibold text-slate-500">
          Step {stepIndex + 1} of {STEPS.length}
        </p>
        <h1 className="text-xl font-bold text-slate-900 mt-0.5 flex items-center gap-2">
          {step.key === 'left' && <ArrowLeft className="w-5 h-5 text-blue-600" />}
          {step.title}
          {step.key === 'right' && <ArrowRight className="w-5 h-5 text-blue-600" />}
        </h1>
        <p className="text-sm text-slate-600 mt-1 leading-relaxed">{step.hint}</p>

        {/* viewfinder / preview */}
        <div className="mt-4 mx-auto w-full max-w-[min(100%,calc(52dvh*0.75))] aspect-[3/4] rounded-3xl overflow-hidden bg-slate-900 relative shadow-sm">
          {shot ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shot.url} alt="Your photo" className="w-full h-full object-cover" />
              {shot.state === 'checking' && (
                <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center text-white gap-2">
                  <Loader2 className="w-8 h-8 animate-spin" />
                  <span className="text-sm font-semibold">Checking your photo…</span>
                </div>
              )}
              {shot.state === 'ok' && (
                <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500 text-white text-xs font-bold shadow">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {shot.message}
                  {shot.quality !== null && <span className="font-medium opacity-90">· {shot.quality}%</span>}
                </span>
              )}
            </>
          ) : live ? (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-[68%] aspect-[3/4] rounded-[50%] border-[3px] border-white/90 shadow-[0_0_0_9999px_rgba(2,6,23,0.45)]" />
              </div>
              {!streamReady && (
                <div className="absolute inset-0 flex items-center justify-center text-white/80 gap-2 text-sm">
                  <Loader2 className="w-5 h-5 animate-spin" /> Starting camera…
                </div>
              )}
              <span className="absolute bottom-3 inset-x-0 mx-auto w-fit px-3 py-1 rounded-full bg-black/60 text-white text-xs font-semibold">
                Fit your face inside the oval
              </span>
            </>
          ) : (
            <div className="w-full h-full bg-gradient-to-b from-slate-800 to-slate-900 flex flex-col items-center justify-center text-white px-6 text-center">
              <PoseIllustration dir={step.key} className="w-32 h-40 text-blue-200" />
              <p className="text-sm text-slate-300 mt-4 leading-relaxed">
                Tap <b className="text-white">Take selfie</b>. Your camera opens; take the photo, then tap <b className="text-white">Use photo</b>.
              </p>
            </div>
          )}
        </div>

        {/* feedback */}
        {shot && (shot.state === 'warn' || shot.state === 'bad') && (
          <div
            className={`mt-3 p-3 rounded-xl text-sm flex gap-2 border ${
              shot.state === 'bad' ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-amber-50 border-amber-200 text-amber-900'
            }`}
          >
            {shot.state === 'bad' ? <XCircle className="w-5 h-5 shrink-0" /> : <AlertTriangle className="w-5 h-5 shrink-0" />}
            <span>{shot.message}</span>
          </div>
        )}
        {notice && !shot && (
          <div className="mt-3 p-3 rounded-xl text-sm flex gap-2 border bg-rose-50 border-rose-200 text-rose-800">
            <XCircle className="w-5 h-5 shrink-0" /> <span>{notice}</span>
          </div>
        )}
        {liveError && !shot && (
          <p className="mt-3 text-xs text-slate-500 text-center">{liveError} Using your phone’s camera app instead.</p>
        )}
      </main>

      <ActionBar>
        {!shot ? (
          <button type="button" onClick={takePhoto} disabled={busy || (live && !streamReady)} className={btnPrimary}>
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Camera className="w-5 h-5" />}
            {live ? 'Capture' : 'Take selfie'}
          </button>
        ) : checking ? (
          <button type="button" disabled className={btnPrimary}>
            <Loader2 className="w-5 h-5 animate-spin" /> Checking…
          </button>
        ) : shot.state === 'ok' ? (
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <button type="button" onClick={retake} className={btnSecondary}>
              <RotateCcw className="w-4 h-4" /> Retake
            </button>
            <button type="button" onClick={goNext} className={btnPrimary}>
              {stepIndex < STEPS.length - 1 ? 'Next' : 'Review'} <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={retake} className={btnPrimary}>
              <RotateCcw className="w-5 h-5" /> Retake photo
            </button>
            {shot.canOverride && (
              <button type="button" onClick={accept} className={btnSecondary}>
                Use this photo anyway
              </button>
            )}
          </>
        )}
      </ActionBar>
    </div>
  );
}
