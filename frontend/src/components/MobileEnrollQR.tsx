'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Smartphone,
  QrCode,
  Loader2,
  CheckCircle2,
  Copy,
  Check,
  RefreshCw,
  AlertTriangle,
  X,
  Wifi,
} from 'lucide-react';
import { api, MobileEnrollSession, MobileEnrollStatus } from '@/lib/api';

interface Props {
  employee: { id: string; fullName: string };
  /**
   * Called once when the phone has sent its photos. Nothing is enrolled yet: the dialog loads the
   * photos for HR to review, and they are only enrolled when HR clicks Save.
   */
  onPhotosReceived: (sessionId: string, angles: string[]) => void;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const LIVE: MobileEnrollStatus[] = ['PENDING', 'OPENED'];

/** The plain-http address a phone on the same Wi-Fi can open (never "localhost"). */
function plainBaseUrl(lanIp: string | null): { base: string; reachable: boolean } {
  const { protocol, hostname, port, origin } = window.location;
  if (!LOCAL_HOSTS.includes(hostname)) return { base: origin, reachable: true };
  if (!lanIp) return { base: origin, reachable: false };
  return { base: `${protocol}//${lanIp}${port ? `:${port}` : ''}`, reachable: true };
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function MobileEnrollQR({ employee, onPhotosReceived }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<MobileEnrollSession | null>(null);
  // secure: HTTPS link (live camera in the page); plain: http on the Wi-Fi IP (phone's camera app).
  const [links, setLinks] = useState<{ secure: string | null; plain: string; plainReachable: boolean } | null>(null);
  const [usePlain, setUsePlain] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());
  const [copied, setCopied] = useState(false);

  const statusRef = useRef<MobileEnrollStatus | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const receivedRef = useRef(false);
  const onPhotosRef = useRef(onPhotosReceived);
  onPhotosRef.current = onPhotosReceived;

  const status: MobileEnrollStatus | null =
    session && LIVE.includes(session.status) && deadline && now >= deadline ? 'EXPIRED' : session?.status ?? null;
  statusRef.current = status;

  const cancelIfUnscanned = useCallback(() => {
    // A code nobody has scanned yet is safe to burn; once the phone has opened it, let the employee finish.
    if (sessionIdRef.current && statusRef.current === 'PENDING') {
      api.cancelMobileEnrollSession(sessionIdRef.current).catch(() => {});
    }
  }, []);

  const createLink = async () => {
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      cancelIfUnscanned();
      const res = await api.createMobileEnrollSession(employee.id);
      const d = res.data;
      const path = `/enroll?token=${encodeURIComponent(d.token)}`;
      const plain = plainBaseUrl(d.lanIp);
      setLinks({
        secure: d.publicBaseUrl ? `${d.publicBaseUrl}${path}` : null,
        plain: `${plain.base}${path}`,
        plainReachable: plain.reachable,
      });
      setUsePlain(false);
      setSession(d);
      sessionIdRef.current = d.sessionId;
      receivedRef.current = false;
      setDeadline(Date.now() + d.secondsRemaining * 1000);
      setNow(Date.now());
      setOpen(true);
    } catch (e: any) {
      setError(e.message || 'Could not create the enrolment link');
    } finally {
      setCreating(false);
    }
  };

  const linkUrl = links ? (links.secure && !usePlain ? links.secure : links.plain) : null;
  const linkReachable = !links || !!(links.secure && !usePlain) || links.plainReachable;
  // A bare IP over HTTPS means the self-signed office certificate: phones warn once.
  const selfSignedHttps = !!linkUrl && /^https:\/\/\d{1,3}(\.\d{1,3}){3}[:/]/.test(linkUrl);

  useEffect(() => {
    if (!linkUrl) return;
    let alive = true;
    QRCode.toDataURL(linkUrl, { width: 480, margin: 1, errorCorrectionLevel: 'M' }).then((data) => alive && setQr(data));
    return () => {
      alive = false;
    };
  }, [linkUrl]);

  // Poll the backend while the link is live so this screen follows the phone.
  useEffect(() => {
    if (!session || !LIVE.includes(session.status)) return;
    const id = session.sessionId;
    const timer = setInterval(async () => {
      try {
        const res = await api.getMobileEnrollSession(id);
        if (sessionIdRef.current !== id) return;
        setSession(res.data);
        if (res.data.status === 'SUBMITTED' && !receivedRef.current) {
          receivedRef.current = true;
          onPhotosRef.current(id, res.data.angles);
        }
      } catch {
        /* transient; keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.sessionId, session?.status]);

  // Countdown tick
  useEffect(() => {
    if (!open || !session || !LIVE.includes(session.status)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, session?.status]);

  // Closing the enrolment dialog burns an unscanned code.
  useEffect(() => () => cancelIfUnscanned(), [cancelIfUnscanned]);

  const close = () => {
    cancelIfUnscanned();
    setOpen(false);
    setSession(null);
    sessionIdRef.current = null;
    setQr(null);
    setLinks(null);
  };

  const copy = async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the link is visible to select manually */
    }
  };

  if (!open) {
    return (
      <div className="p-3.5 rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-blue-50/40 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-white border border-indigo-200 text-indigo-600 flex items-center justify-center shrink-0">
            <Smartphone className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-900">Enrol on {employee.fullName.split(' ')[0]}&apos;s phone</p>
            <p className="text-[11px] text-slate-600 leading-snug">
              Show a QR code. They scan it, take three selfies and give consent on their own phone. No app or login needed.
            </p>
            {error && <p className="text-[11px] text-rose-600 font-semibold mt-1">{error}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={createLink}
          disabled={creating}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm disabled:opacity-60 transition shrink-0"
        >
          {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <QrCode className="w-3.5 h-3.5" />}
          Show QR code
        </button>
      </div>
    );
  }

  const remaining = Math.max(0, (deadline - now) / 1000);
  const received = status === 'SUBMITTED' || status === 'COMPLETED';
  const steps: { key: string; label: string; done: boolean; active: boolean }[] = [
    { key: 'scan', label: 'Scan the code with the phone camera', done: status !== 'PENDING', active: status === 'PENDING' },
    { key: 'capture', label: 'Selfies & consent on the phone', done: received, active: status === 'OPENED' },
    { key: 'review', label: 'Check the photos below, then click Save', done: status === 'COMPLETED', active: status === 'SUBMITTED' },
  ];
  const dead = status === 'EXPIRED' || status === 'CANCELLED';

  return (
    <div className="rounded-2xl border border-indigo-200 bg-white overflow-hidden shadow-sm">
      <div className="px-4 py-2.5 bg-indigo-50/70 border-b border-indigo-100 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold text-indigo-900">
          <Smartphone className="w-4 h-4 text-indigo-600" /> Phone enrolment for {employee.fullName}
        </div>
        <button type="button" onClick={close} className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-white" aria-label="Close QR code">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 flex flex-col sm:flex-row gap-5">
        {/* QR */}
        <div className="shrink-0 mx-auto sm:mx-0">
          <div className="relative w-52 h-52 rounded-xl border border-slate-200 bg-white p-2">
            {qr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt="QR code for phone face enrolment"
                className={`w-full h-full transition ${received || dead ? 'opacity-10 blur-[2px]' : ''}`}
              />
            )}
            {received && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-emerald-700">
                <CheckCircle2 className="w-12 h-12 text-emerald-500" />
                <span className="text-sm font-bold mt-1">{status === 'COMPLETED' ? 'Saved' : 'Photos received'}</span>
              </div>
            )}
            {dead && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-700 gap-2">
                <span className="text-xs font-bold">{status === 'EXPIRED' ? 'Code expired' : 'Code cancelled'}</span>
                <button
                  type="button"
                  onClick={createLink}
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${creating ? 'animate-spin' : ''}`} /> New code
                </button>
              </div>
            )}
          </div>
          {status && LIVE.includes(status) && (
            <p className="text-center text-[11px] text-slate-500 mt-1.5 tabular-nums">
              Expires in <b className="text-slate-700">{fmt(remaining)}</b> &bull; single use
            </p>
          )}
        </div>

        {/* Progress + link */}
        <div className="flex-1 min-w-0 space-y-3">
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2.5 text-xs">
                {s.done ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                ) : s.active && !dead ? (
                  <Loader2 className="w-5 h-5 text-indigo-500 animate-spin shrink-0" />
                ) : (
                  <span className="w-5 h-5 rounded-full border border-slate-300 text-[10px] font-bold text-slate-400 flex items-center justify-center shrink-0">
                    {i + 1}
                  </span>
                )}
                <span className={s.done ? 'text-slate-900 font-semibold' : s.active ? 'text-indigo-900 font-semibold' : 'text-slate-500'}>
                  {s.label}
                  {s.key === 'capture' && status === 'OPENED' && <span className="text-indigo-600 font-normal"> (opened on phone)</span>}
                </span>
              </li>
            ))}
          </ol>

          {status === 'SUBMITTED' ? (
            <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-900">
              <b>{session?.angles.length || 3} photos received from the phone.</b> They are <b>not saved yet</b>. Check them below, then
              click <b>Save</b> to enrol the face.
            </div>
          ) : status === 'COMPLETED' ? (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-semibold">
              The photos from the phone were saved.
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-[11px] text-slate-600 space-y-1">
              <p className="flex items-center gap-1.5 font-semibold text-slate-700">
                <Wifi className="w-3.5 h-3.5" /> The phone must be on the office Wi-Fi.
              </p>
              <p>Open the phone&apos;s normal camera app, point it at the code and tap the link that appears.</p>
              {selfSignedHttps && (
                <p className="text-slate-700">
                  <b>First time on a phone</b> it shows a &ldquo;not private&rdquo; warning (office certificate). Android:{' '}
                  <b>Advanced → Proceed</b>. iPhone: <b>Show Details → visit this website</b>.
                </p>
              )}
            </div>
          )}

          {!linkReachable && (
            <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Couldn&apos;t detect this PC&apos;s Wi-Fi address, so the code points at <b>localhost</b>, which a phone can&apos;t open.
                Open the dashboard using the PC&apos;s IP address instead (e.g. http://192.168.x.x:3000).
              </span>
            </div>
          )}

          {linkUrl && (
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-[10px] font-mono text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 select-all">
                {linkUrl}
              </code>
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          )}

          {links?.secure && !received && !dead && (
            <button
              type="button"
              onClick={() => setUsePlain((v) => !v)}
              className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
            >
              {usePlain
                ? 'Switch back to the HTTPS link (live camera in the page)'
                : 'Phone won’t open it? Use the plain Wi-Fi link instead (opens the camera app)'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
