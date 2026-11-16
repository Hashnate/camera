'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Camera, Upload, X, ShieldCheck, Trash2, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { api, FaceEnrollmentSummary } from '@/lib/api';

interface Props {
  employee: { id: string; fullName: string; employeeCode: string };
  enrollment?: FaceEnrollmentSummary;
  maxSamples: number;
  onClose: () => void;
  onChanged: () => void;
}

type Mode = 'upload' | 'webcam';

export function FaceEnrollModal({ employee, enrollment, maxSamples, onClose, onChanged }: Props) {
  const [mode, setMode] = useState<Mode>('upload');
  const [image, setImage] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const samples = enrollment?.samples ?? 0;
  const full = samples >= maxSamples;

  // Start / stop the webcam with the tab.
  useEffect(() => {
    if (mode !== 'webcam') return;
    let cancelled = false;
    setCamError(null);
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' } })
      .then((stream) => {
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch((e) => setCamError(`Webcam unavailable: ${e.message}`));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pickImage = (blob: Blob) => {
    setImage(blob);
    setPreview(URL.createObjectURL(blob));
    setMessage(null);
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    canvas.toBlob((b) => b && pickImage(b), 'image/jpeg', 0.92);
  };

  const submit = async () => {
    if (!image || !consent) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.enrollFace(employee.id, image, mode === 'webcam' ? 'WEBCAM' : 'UPLOAD');
      setMessage({ ok: true, text: res.message });
      setImage(null);
      setPreview(null);
      onChanged();
    } catch (e: any) {
      setMessage({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!confirm(`Delete all face data for ${employee.fullName}? Automatic attendance will stop for them.`)) return;
    setBusy(true);
    try {
      const res = await api.revokeFace(employee.id);
      setMessage({ ok: true, text: res.message });
      onChanged();
    } catch (e: any) {
      setMessage({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Face ID enrolment</h3>
            <p className="text-xs text-slate-500">
              {employee.fullName} · <span className="font-mono">{employee.employeeCode}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600">
              {samples > 0 ? (
                <>
                  <b>{samples}</b> of {maxSamples} face samples enrolled
                </>
              ) : (
                'Not enrolled yet'
              )}
            </span>
            {samples > 0 && (
              <button
                onClick={revoke}
                disabled={busy}
                className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-700 font-semibold disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Revoke & delete face data
              </button>
            )}
          </div>

          {!full && (
            <>
              <p className="text-[11px] text-slate-500">
                Add 2–3 samples (e.g. with and without glasses, different lighting) for the most reliable recognition.
                Use a clear, front-facing photo showing only this employee.
              </p>

              <div className="flex gap-1 p-1 bg-slate-100 rounded-lg text-xs font-semibold">
                {(['upload', 'webcam'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => { setMode(m); setImage(null); setPreview(null); }}
                    className={`flex-1 py-1.5 rounded-md inline-flex items-center justify-center gap-1.5 ${
                      mode === m ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'
                    }`}
                  >
                    {m === 'upload' ? <Upload className="w-3.5 h-3.5" /> : <Camera className="w-3.5 h-3.5" />}
                    {m === 'upload' ? 'Upload photo' : 'Use webcam'}
                  </button>
                ))}
              </div>

              <div className="aspect-video bg-slate-900 rounded-lg overflow-hidden flex items-center justify-center relative">
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="Selected face" className="w-full h-full object-contain" />
                ) : mode === 'webcam' ? (
                  camError ? (
                    <p className="text-xs text-rose-300 px-4 text-center">{camError}</p>
                  ) : (
                    <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100" />
                  )
                ) : (
                  <label className="cursor-pointer text-xs text-slate-300 flex flex-col items-center gap-2">
                    <Upload className="w-6 h-6" />
                    Choose a JPEG or PNG
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="hidden"
                      onChange={(e) => e.target.files?.[0] && pickImage(e.target.files[0])}
                    />
                  </label>
                )}
              </div>

              {mode === 'webcam' && !camError && (
                <button
                  onClick={preview ? () => { setImage(null); setPreview(null); } : capture}
                  className="w-full py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {preview ? 'Retake' : 'Capture'}
                </button>
              )}

              <label className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 border border-blue-100 text-[11px] text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <b>{employee.fullName}</b> has given informed consent to face recognition for attendance. Only a
                  numeric face template is stored (never the photo), it is used only for attendance, and they can
                  withdraw consent at any time, which deletes it.
                </span>
              </label>

              <button
                onClick={submit}
                disabled={!image || !consent || busy}
                className="w-full py-2.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-40 inline-flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                Enrol face sample
              </button>
            </>
          )}

          {message && (
            <p
              className={`text-xs flex items-start gap-1.5 ${message.ok ? 'text-emerald-700' : 'text-rose-600'}`}
              role="status"
            >
              {message.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
              {message.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
