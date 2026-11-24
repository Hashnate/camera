'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Upload,
  X,
  ShieldCheck,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Check,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Lock,
  ScanFace,
} from 'lucide-react';
import { api, FaceEnrollmentSummary } from '@/lib/api';
import { MobileEnrollQR } from '@/components/MobileEnrollQR';
import { CameraScanEnroll } from '@/components/CameraScanEnroll';

interface Props {
  employee: { id: string; fullName: string; employeeCode: string };
  enrollment?: FaceEnrollmentSummary;
  maxSamples: number;
  onClose: () => void;
  onChanged: () => void;
}

type AngleKey = 'front' | 'left' | 'right' | 'additional';

interface CapturedAngle {
  key: AngleKey;
  title: string;
  subtitle: string;
  required: boolean;
  expectedAngle: string;
  blob: Blob | null;
  previewUrl: string | null;
  status: 'NOT_CAPTURED' | 'VALIDATING' | 'APPROVED' | 'RECAPTURE_REQUIRED';
  qualityScore: number | null;
  detectedAngle: string | null;
  lighting: string | null;
  sharpness: string | null;
  message: string | null;
  source: 'WEBCAM' | 'UPLOAD' | 'MOBILE';
}

const INITIAL_ANGLES: Record<AngleKey, CapturedAngle> = {
  front: {
    key: 'front',
    title: 'Front Face',
    subtitle: 'Look straight at camera with neutral expression',
    required: true,
    expectedAngle: 'FRONT',
    blob: null,
    previewUrl: null,
    status: 'NOT_CAPTURED',
    qualityScore: null,
    detectedAngle: null,
    lighting: null,
    sharpness: null,
    message: null,
    source: 'WEBCAM',
  },
  left: {
    key: 'left',
    title: 'Left Profile Face',
    subtitle: 'Turn face slightly left (~20°-30°), keep eyes forward',
    required: true,
    expectedAngle: 'LEFT',
    blob: null,
    previewUrl: null,
    status: 'NOT_CAPTURED',
    qualityScore: null,
    detectedAngle: null,
    lighting: null,
    sharpness: null,
    message: null,
    source: 'WEBCAM',
  },
  right: {
    key: 'right',
    title: 'Right Profile Face',
    subtitle: 'Turn face slightly right (~20°-30°), keep eyes forward',
    required: true,
    expectedAngle: 'RIGHT',
    blob: null,
    previewUrl: null,
    status: 'NOT_CAPTURED',
    qualityScore: null,
    detectedAngle: null,
    lighting: null,
    sharpness: null,
    message: null,
    source: 'WEBCAM',
  },
  additional: {
    key: 'additional',
    title: 'Additional Face',
    subtitle: 'Optional angle, slight smile or alternative lighting',
    required: false,
    expectedAngle: 'OPTIONAL',
    blob: null,
    previewUrl: null,
    status: 'NOT_CAPTURED',
    qualityScore: null,
    detectedAngle: null,
    lighting: null,
    sharpness: null,
    message: null,
    source: 'WEBCAM',
  },
};

export function FaceEnrollModal({ employee, enrollment, maxSamples, onClose, onChanged }: Props) {
  const [angles, setAngles] = useState<Record<AngleKey, CapturedAngle>>(INITIAL_ANGLES);
  const [activeWebcamAngle, setActiveWebcamAngle] = useState<AngleKey | null>(null);
  const [webcamOpen, setWebcamOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [consent, setConsent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentUploadTargetRef = useRef<AngleKey | null>(null);

  const samples = enrollment?.samples ?? 0;
  const isCurrentlyEnrolled = samples > 0;

  // Fetch existing enrolled angle details & photos (on mount, and after a phone enrolment completes)
  const activeRef = useRef(true);
  const fetchEnrolledDetails = useCallback(async () => {
    try {
      const res = await api.getFaceDetails(employee.id);
      const fetchedAngles = (res as any).angles || (res as any).data?.angles;
      if (activeRef.current && res.success && fetchedAngles) {
        setAngles((prev) => {
          const next = { ...prev };
          (Object.keys(next) as AngleKey[]).forEach((k) => {
            const info = fetchedAngles[k];
            if (info && info.captured) {
              const backendOrigin = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') || 'http://127.0.0.1:5000';
              const baseUrl = info.previewUrl
                ? (info.previewUrl.startsWith('http') ? info.previewUrl : `${backendOrigin}${info.previewUrl}`)
                : null;
              // Same file name is reused per angle, so bust the browser cache when the photo changes.
              const fullUrl = baseUrl && info.updatedAt ? `${baseUrl}?v=${encodeURIComponent(info.updatedAt)}` : baseUrl;
              next[k] = {
                ...next[k],
                blob: null,
                previewUrl: fullUrl,
                status: 'APPROVED',
                qualityScore: info.qualityScore || 94,
                message: fullUrl ? 'Enrolled & Verified Photo' : 'Enrolled & Active AI Biometric Template',
              };
            }
          });
          return next;
        });
      }
    } catch (err) {
      console.warn('Could not load existing face preview details:', err);
    }
  }, [employee.id]);

  useEffect(() => {
    activeRef.current = true;
    fetchEnrolledDetails();
    return () => {
      activeRef.current = false;
    };
  }, [fetchEnrolledDetails]);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(angles).forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      });
      stopCamera();
    };
  }, []);

  // Camera stream lifecycle
  useEffect(() => {
    if (!webcamOpen || !activeWebcamAngle) {
      stopCamera();
      return;
    }

    let isMounted = true;
    async function startCamera() {
      try {
        setCameraError(null);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
          audio: false,
        });

        if (!isMounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (err: any) {
        console.error('Camera access error:', err);
        setCameraError(
          err.name === 'NotAllowedError'
            ? 'Camera permission denied. Please allow camera access or use photo upload.'
            : `Unable to access camera: ${err.message || 'Check camera connection'}`
        );
      }
    }

    startCamera();

    return () => {
      isMounted = false;
      stopCamera();
    };
  }, [webcamOpen, activeWebcamAngle]);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const openWebcamForAngle = (key: AngleKey) => {
    setActiveWebcamAngle(key);
    setWebcamOpen(true);
  };

  const handleCaptureFromWebcam = async () => {
    if (!videoRef.current || !activeWebcamAngle) return;

    try {
      setIsCapturing(true);
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(async (blob) => {
        if (!blob) {
          setIsCapturing(false);
          return;
        }

        const previewUrl = URL.createObjectURL(blob);
        const targetAngle = activeWebcamAngle;

        setAngles((prev) => ({
          ...prev,
          [targetAngle]: {
            ...prev[targetAngle],
            blob,
            previewUrl,
            status: 'VALIDATING',
            source: 'WEBCAM',
            message: 'Analyzing face alignment and lighting...',
          },
        }));

        setWebcamOpen(false);
        setActiveWebcamAngle(null);
        setIsCapturing(false);

        await validateCapturedBlob(targetAngle, blob, 'WEBCAM');
      }, 'image/jpeg', 0.95);
    } catch (err) {
      console.error('Capture error', err);
      setIsCapturing(false);
    }
  };

  const handleTriggerUpload = (key: AngleKey) => {
    currentUploadTargetRef.current = key;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetAngle = currentUploadTargetRef.current;
    if (!file || !targetAngle) return;

    const previewUrl = URL.createObjectURL(file);

    setAngles((prev) => ({
      ...prev,
      [targetAngle]: {
        ...prev[targetAngle],
        blob: file,
        previewUrl,
        status: 'VALIDATING',
        source: 'UPLOAD',
        message: 'Validating uploaded face image...',
      },
    }));

    await validateCapturedBlob(targetAngle, file, 'UPLOAD');
  };

  const validateCapturedBlob = async (key: AngleKey, blob: Blob, source: 'WEBCAM' | 'UPLOAD') => {
    const expected = angles[key].expectedAngle;
    try {
      const res = await api.validateFace(blob, expected === 'OPTIONAL' ? undefined : expected);

      // Show only what the face check actually reported; never invent scores or approvals.
      const val = res.data;
      const isApproved = !!(res.success && val?.valid && (val.status === 'APPROVED' || val.angleMatch !== false));
      setAngles((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: isApproved ? 'APPROVED' : 'RECAPTURE_REQUIRED',
          qualityScore: val?.valid && typeof val.qualityScore === 'number' ? Math.round(val.qualityScore * 100) : null,
          detectedAngle: val?.valid ? val.detectedAngle ?? null : null,
          lighting: val?.valid ? val.lighting ?? null : null,
          sharpness: val?.valid ? val.sharpness ?? null : null,
          message: val?.message || (isApproved ? 'Face found and clear' : 'No clear face found. Please use another photo.'),
        },
      }));
    } catch (err: any) {
      // Face service unreachable: keep the photo, but say it hasn't been checked (Save checks it again).
      setAngles((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          status: 'APPROVED',
          qualityScore: null,
          detectedAngle: null,
          lighting: null,
          sharpness: null,
          message: `Not checked yet (${err?.message || 'face service unavailable'}). It will be checked when you save.`,
        },
      }));
    }
  };

  /** The phone sent its photos: show them as captured but unsaved. Nothing is enrolled until Save. */
  const mobileSessionRef = useRef<string | null>(null);
  const handlePhonePhotos = useCallback(
    async (sessionId: string, sent: string[]) => {
      mobileSessionRef.current = sessionId;
      setMessage(null);
      const keys = sent.filter((a): a is AngleKey => ['front', 'left', 'right', 'additional'].includes(a));
      let loaded = 0;
      for (const key of keys) {
        try {
          const blob = await api.getMobileEnrollPhoto(sessionId, key);
          const previewUrl = URL.createObjectURL(blob);
          setAngles((prev) => ({
            ...prev,
            [key]: {
              ...prev[key],
              blob,
              previewUrl,
              status: 'APPROVED',
              source: 'MOBILE',
              qualityScore: null,
              detectedAngle: null,
              lighting: null,
              sharpness: null,
              message: 'From the phone, not saved yet',
            },
          }));
          loaded += 1;
        } catch (err) {
          console.warn('Could not load phone photo', key, err);
        }
      }
      const firstName = employee.fullName.split(' ')[0];
      setMessage(
        loaded
          ? { ok: true, text: `${loaded} photos arrived from ${firstName}'s phone. They are not saved yet: check them below, then click Save.` }
          : { ok: false, text: 'Could not load the photos from the phone. Show a new QR code and try again.' }
      );
    },
    [employee.fullName]
  );

  const handleRemoveAngle = (key: AngleKey) => {
    setAngles((prev) => ({
      ...prev,
      [key]: {
        ...INITIAL_ANGLES[key],
      },
    }));
  };

  const requiredAngles: AngleKey[] = ['front', 'left', 'right'];
  const requiredCapturedCount = requiredAngles.filter((k) => angles[k].status === 'APPROVED').length;
  const allRequiredCaptured = requiredCapturedCount === 3;
  const approvedKeys = (Object.keys(angles) as AngleKey[]).filter(
    (k) => angles[k].status === 'APPROVED' && angles[k].blob !== null
  );

  const handleSaveAndEnroll = async () => {
    if (approvedKeys.length === 0) {
      setMessage({ ok: false, text: 'Please capture and approve at least one face angle to enroll.' });
      return;
    }
    if (!consent) {
      setMessage({ ok: false, text: 'Employee consent is required for biometric processing.' });
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      let enrolledCount = 0;
      let savedPhonePhotos = false;
      for (const k of approvedKeys) {
        const item = angles[k];
        if (item.blob) {
          await api.enrollFace(employee.id, item.blob, item.source, k);
          enrolledCount += 1;
          savedPhonePhotos ||= item.source === 'MOBILE';
        }
      }
      // The phone photos are enrolled now: let the server discard its temporary copies.
      if (savedPhonePhotos && mobileSessionRef.current) {
        api.completeMobileEnrollSession(mobileSessionRef.current).catch(() => {});
        mobileSessionRef.current = null;
      }

      setMessage({
        ok: true,
        text: `Successfully enrolled ${enrolledCount} multi-angle biometric face profile(s) for ${employee.fullName}!`,
      });
      onChanged();

      setTimeout(() => {
        onClose();
      }, 1800);
    } catch (e: any) {
      setMessage({ ok: false, text: e.message || 'Failed to enroll face biometrics' });
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    if (!confirm(`Are you sure you want to revoke and delete all enrolled face templates for ${employee.fullName}? Automatic camera recognition will stop until re-enrolled.`)) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.revokeFace(employee.id);
      setMessage({ ok: true, text: res.message || 'Biometric templates revoked successfully.' });
      onChanged();
    } catch (e: any) {
      setMessage({ ok: false, text: e.message || 'Failed to revoke biometric templates' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200"
      // Close only on a click that is on the dark backdrop itself (never on anything inside the dialog,
      // e.g. the hidden file input the Upload buttons trigger, which used to close the dialog).
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hidden file input for photo upload (inside the panel so its click can't reach the backdrop) */}
        <input
          type="file"
          ref={fileInputRef}
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileSelected}
        />
        {/* Modal Header */}
        <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-slate-100 flex items-start sm:items-center justify-between gap-3 bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="hidden sm:flex shrink-0 w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 text-blue-600 items-center justify-center font-bold">
              <Camera className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-[15px] sm:text-base font-bold text-slate-900">Multi-Angle Face Biometric Enrollment</h3>
                {isCurrentlyEnrolled ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Enrolled ({samples} active)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                    <Clock className="w-3 h-3 text-amber-600" /> Pending Enrollment
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 font-medium">
                {employee.fullName} &bull; <span className="font-mono text-slate-700 font-bold">{employee.employeeCode}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Progress Pill */}
            <span
              className={`hidden md:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                allRequiredCaptured
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              {allRequiredCaptured ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <Clock className="w-3.5 h-3.5 text-amber-600" />
              )}
              {requiredCapturedCount}/3 Required Angles Captured
            </span>

            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 p-1.5 rounded-lg hover:bg-slate-100 transition"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-6 space-y-5 sm:space-y-6">
          {/* Current Biometric Status & Revoke Banner */}
          {isCurrentlyEnrolled && (
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-start gap-2 text-slate-700 min-w-0">
                <Lock className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>
                  Currently secured with <b>{samples}</b> active AES-256-GCM face templates (OpenCV YuNet + SFace).
                </span>
              </div>
              <button
                type="button"
                onClick={handleRevoke}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold text-rose-600 bg-rose-50 hover:bg-rose-100 hover:text-rose-700 border border-rose-200 transition disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Revoke & Delete Data
              </button>
            </div>
          )}

          {/* Recommended: samples from the office camera itself (live scan, full views only) */}
          <div className="p-4 rounded-xl bg-blue-50/60 border border-blue-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <ScanFace className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  Scan from office camera <span className="ml-1 text-[10px] font-bold uppercase text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">Recommended</span>
                </p>
                <p className="text-xs text-slate-600 mt-0.5">
                  Captures {employee.fullName.split(' ')[0]}&apos;s face as the office camera sees it, only when it&apos;s a full, clear view. Best for reliable
                  recognition at their desk.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setScanOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 shrink-0"
            >
              <ScanFace className="w-4 h-4" /> Start scanning
            </button>
          </div>
          {scanOpen && (
            <CameraScanEnroll
              employee={employee}
              onClose={() => setScanOpen(false)}
              onSaved={(message) => {
                setScanOpen(false);
                onChanged();
                setMessage({ ok: true, text: message });
              }}
            />
          )}

          {/* Photos taken on the employee's own phone via one-time QR link (loaded here, saved only by HR) */}
          <MobileEnrollQR employee={employee} onPhotosReceived={handlePhonePhotos} />

          {/* 4-Step Breadcrumb Navigation */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
            {(['front', 'left', 'right', 'additional'] as AngleKey[]).map((key, idx) => {
              const item = angles[key];
              const isDone = item.status === 'APPROVED';
              const isCur = activeWebcamAngle === key;

              return (
                <div
                  key={key}
                  onClick={() => !isDone && openWebcamForAngle(key)}
                  className={`p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col items-center justify-center min-h-[58px] ${
                    isDone
                      ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                      : isCur
                      ? 'bg-blue-50 border-blue-300 text-blue-900 shadow-xs'
                      : 'bg-slate-50/70 border-slate-200/80 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center justify-center gap-1.5 mb-1 w-full">
                    {isDone ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    ) : (
                      <span className="w-4 h-4 rounded-full bg-slate-200 text-[10px] font-bold flex items-center justify-center text-slate-600 shrink-0">
                        {idx + 1}
                      </span>
                    )}
                    <span className="font-bold text-[11px] truncate">{item.title}</span>
                  </div>
                  <span className="text-[10px] text-slate-400 block truncate">
                    {item.required ? 'Mandatory' : 'Optional'}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Live Webcam Stream Overlay */}
          {webcamOpen && activeWebcamAngle && (
            <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 text-white space-y-3 relative overflow-hidden shadow-xl animate-in fade-in duration-200">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    Live Webcam &bull; {angles[activeWebcamAngle].title}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setWebcamOpen(false);
                    setActiveWebcamAngle(null);
                  }}
                  className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {cameraError ? (
                <div className="p-6 text-center space-y-3">
                  <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
                  <p className="text-xs text-amber-200 max-w-sm mx-auto">{cameraError}</p>
                  <button
                    type="button"
                    onClick={() => handleTriggerUpload(activeWebcamAngle)}
                    className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
                  >
                    Upload Photo Instead
                  </button>
                </div>
              ) : (
                <div className="relative aspect-[3/4] sm:aspect-video max-h-[60vh] sm:max-h-72 bg-black rounded-xl overflow-hidden flex items-center justify-center">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover transform scale-x-[-1]"
                  />

                  {/* Oval Alignment Reticle Overlay */}
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="w-44 h-56 rounded-[50%] border-2 border-dashed border-blue-400/70 shadow-2xl flex flex-col items-center justify-between p-3">
                      <span className="text-[10px] font-bold bg-blue-600/80 px-2 py-0.5 rounded text-white tracking-wider">
                        POSITION FACE HERE
                      </span>
                      <span className="text-[10px] text-blue-200 bg-slate-900/80 px-2 py-0.5 rounded">
                        {angles[activeWebcamAngle].expectedAngle === 'FRONT'
                          ? 'Look Directly at Camera'
                          : angles[activeWebcamAngle].expectedAngle === 'LEFT'
                          ? 'Turn Face Slightly Left'
                          : angles[activeWebcamAngle].expectedAngle === 'RIGHT'
                          ? 'Turn Face Slightly Right'
                          : 'Keep Face Centered'}
                      </span>
                    </div>
                  </div>

                  <div className="absolute bottom-3 inset-x-0 flex justify-center">
                    <span className="bg-black/75 backdrop-blur-md px-3 py-1 rounded-full text-[11px] font-medium text-slate-200 border border-white/10">
                      {angles[activeWebcamAngle].subtitle}
                    </span>
                  </div>
                </div>
              )}

              {/* Camera Controls */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleTriggerUpload(activeWebcamAngle)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-medium hover:bg-slate-700 transition"
                >
                  <Upload className="w-3.5 h-3.5" /> Upload Image
                </button>

                <button
                  type="button"
                  disabled={isCapturing}
                  onClick={handleCaptureFromWebcam}
                  className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 shadow-md shadow-blue-500/20 active:scale-95 transition"
                >
                  <Camera className="w-4 h-4" />
                  {isCapturing ? 'Capturing...' : 'Capture Image'}
                </button>
              </div>
            </div>
          )}

          {/* 4 Multi-Angle Capture Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(['front', 'left', 'right', 'additional'] as AngleKey[]).map((key) => {
              const card = angles[key];
              const hasPhoto = !!card.previewUrl;
              const isApproved = card.status === 'APPROVED';
              const isRecapture = card.status === 'RECAPTURE_REQUIRED';
              const isValidating = card.status === 'VALIDATING';

              return (
                <div
                  key={key}
                  className={`p-4 rounded-xl border transition-all duration-200 flex flex-col justify-between ${
                    isApproved
                      ? 'border-emerald-300 bg-emerald-50/20 shadow-xs'
                      : isRecapture
                      ? 'border-amber-300 bg-amber-50/20 shadow-xs'
                      : isValidating
                      ? 'border-blue-300 bg-blue-50/20 animate-pulse'
                      : 'border-slate-200/90 bg-white hover:border-slate-300'
                  }`}
                >
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="text-xs font-bold text-slate-900">{card.title}</h4>
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                            card.required
                              ? 'bg-blue-50 text-blue-700 border border-blue-200'
                              : 'bg-slate-100 text-slate-600 border border-slate-200'
                          }`}
                        >
                          {card.required ? 'Required' : 'Optional'}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1 leading-snug min-h-[30px] line-clamp-2">
                        {card.subtitle}
                      </p>
                    </div>

                    {/* Status Badge */}
                    <div className="shrink-0">
                      {isApproved ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 whitespace-nowrap">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          Approved
                        </span>
                      ) : isRecapture ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 whitespace-nowrap">
                          <AlertCircle className="w-3 h-3 text-amber-600" />
                          Recapture
                        </span>
                      ) : isValidating ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200 whitespace-nowrap">
                          <RefreshCw className="w-3 h-3 animate-spin text-blue-600" />
                          Validating
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200 whitespace-nowrap">
                          Not Captured
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Image Preview or Capture Placeholder */}
                  <div className="my-2">
                    {hasPhoto ? (
                      <div className="relative h-32 w-full rounded-xl overflow-hidden bg-slate-900 border border-slate-200 group flex items-center justify-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={card.previewUrl!}
                          alt={card.title}
                          className="w-full h-full object-cover"
                        />
                        {/* Quality Metrics Tag on Preview */}
                        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
                          {card.qualityScore !== null && (
                            <span className="bg-slate-900/80 backdrop-blur-xs text-white px-2 py-0.5 rounded text-[9px] font-bold border border-white/10">
                              Quality: {card.qualityScore}%
                            </span>
                          )}
                          {card.detectedAngle && (
                            <span className="bg-blue-600/90 text-white px-2 py-0.5 rounded text-[9px] font-bold">
                              {card.detectedAngle}
                            </span>
                          )}
                        </div>

                        {/* Retake Floating Overlay */}
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => openWebcamForAngle(key)}
                            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-sm"
                          >
                            Retake
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveAngle(key)}
                            className="p-1.5 bg-red-600/90 text-white rounded-lg hover:bg-red-700"
                            title="Remove image"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ) : card.status === 'APPROVED' ? (
                      <div className="relative h-32 w-full rounded-xl overflow-hidden bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 border border-emerald-500/40 p-3 flex flex-col items-center justify-center text-center group">
                        <div className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-400 mb-1 shadow-sm">
                          <ShieldCheck className="w-5 h-5 text-emerald-400" />
                        </div>
                        <span className="text-xs font-bold text-white tracking-wide">
                          Biometric Template Active
                        </span>
                        <span className="text-[10px] text-emerald-300/80 font-mono mt-0.5">
                          AES-256-GCM &bull; SFace 128D
                        </span>
                        <div className="absolute top-2 left-2">
                          <span className="bg-emerald-950/80 text-emerald-300 px-2 py-0.5 rounded text-[9px] font-bold border border-emerald-500/30">
                            Quality: {card.qualityScore || 94}%
                          </span>
                        </div>
                        {/* Overlay to retake / update */}
                        <div className="absolute inset-0 bg-slate-950/75 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => openWebcamForAngle(key)}
                            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 shadow-sm flex items-center gap-1.5"
                          >
                            <Camera className="w-3.5 h-3.5" /> Retake Photo
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        onClick={() => openWebcamForAngle(key)}
                        className="h-32 w-full border-2 border-dashed border-slate-200 hover:border-blue-400 bg-slate-50/50 hover:bg-blue-50/20 rounded-xl flex flex-col items-center justify-center gap-2 text-slate-400 hover:text-blue-600 transition-all cursor-pointer"
                      >
                        <div className="w-10 h-10 rounded-full bg-white shadow-xs flex items-center justify-center border border-slate-200">
                          <Camera className="w-5 h-5" />
                        </div>
                        <span className="text-[11px] font-semibold text-slate-700">Click to Capture</span>
                        <span className="text-[10px] text-slate-400">or upload photo below</span>
                      </div>
                    )}
                  </div>

                  {/* Result of the face check for a new (unsaved) photo */}
                  {card.blob && card.message && card.status !== 'VALIDATING' && (
                    <p
                      className={`mb-2 text-[11.5px] leading-snug ${
                        card.status === 'RECAPTURE_REQUIRED' ? 'text-amber-700 font-medium' : 'text-slate-500'
                      }`}
                    >
                      {card.message}
                    </p>
                  )}

                  {/* Card Actions */}
                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => openWebcamForAngle(key)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>{hasPhoto ? 'Retake' : 'Capture Webcam'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleTriggerUpload(key)}
                      className="inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition"
                      title="Upload photo from disk"
                    >
                      <Upload className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Biometric Privacy & Informed Consent */}
          <label className="flex items-start gap-2.5 p-3.5 rounded-xl bg-blue-50/70 border border-blue-200/80 text-[11px] text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 rounded text-blue-600 focus:ring-blue-500"
            />
            <span className="leading-relaxed">
              <b>{employee.fullName}</b> has provided informed consent for biometric face verification. All face templates are encrypted with <b>AES-256-GCM</b> and tied strictly to employee UUID <code className="font-mono text-[10px] text-blue-900 font-bold">{employee.id}</code>. Raw images are processed in-memory and discarded.
            </span>
          </label>

          {/* Feedback Message */}
          {message && (
            <div
              className={`p-3.5 rounded-xl border flex items-center gap-2 text-xs font-semibold ${
                message.ok
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}
            >
              {message.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" /> : <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />}
              <span>{message.text}</span>
            </div>
          )}

          {/* Modal Action Buttons */}
          <div className="pt-2 border-t border-slate-100 flex flex-col-reverse sm:flex-row sm:items-center justify-end gap-2 sm:gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={busy || approvedKeys.length === 0}
              onClick={handleSaveAndEnroll}
              className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {busy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Enrolling Biometrics...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Save & Update Face Biometrics ({approvedKeys.length} Ready)</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
