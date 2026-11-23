'use client';

/** Choose a new password: required after an admin creates the account or resets it, and available any time
 * from the account menu. Other devices are signed out afterwards. */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Check, Eye, EyeOff, KeyRound } from 'lucide-react';
import { api, authApi, getStoredToken, setStoredToken, type SessionUser } from '@/lib/api';
import { homeFor } from '@/lib/nav';

const field =
  'w-full h-10 rounded-lg bg-white px-3 pr-10 text-[14px] text-slate-900 placeholder-slate-400 ring-1 ring-inset ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-600 transition';

function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-slate-700 mb-1.5">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={field}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-400 hover:text-slate-700"
          aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

export default function ChangePasswordPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getStoredToken()) {
      router.replace('/login');
      return;
    }
    api.getMe().then((r) => setUser(r.user)).catch(() => router.replace('/login'));
  }, [router]);

  const forced = !!user?.mustChangePassword;
  const checks = [
    { ok: next.length >= 8, text: 'At least 8 characters' },
    { ok: /[A-Za-z]/.test(next) && /\d/.test(next), text: 'Letters and numbers' },
    { ok: next.length > 0 && next === confirm, text: 'Both new passwords match' },
    { ok: next.length > 0 && next !== current, text: 'Different from the current one' },
  ];
  const valid = checks.every((c) => c.ok) && current.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.changePassword(current, next);
      setStoredToken(res.token);
      router.replace(homeFor(res.user.permissions, !!res.user.employee));
    } catch (err: any) {
      setError(err.message || 'Could not change the password');
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setStoredToken(null);
    router.replace('/login');
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#f6f7f9] flex items-center justify-center">
        <div className="w-7 h-7 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f7f9] flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <span className="w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-md shadow-blue-600/25">
            <KeyRound className="w-5 h-5" />
          </span>
          <h1 className="mt-4 text-[22px] font-semibold tracking-tight text-slate-900">{forced ? 'Choose your password' : 'Change your password'}</h1>
          <p className="mt-1 text-[13.5px] text-slate-500">
            {forced
              ? `Welcome, ${user.fullName}. Replace the temporary password your admin gave you.`
              : 'You stay signed in here; other devices are signed out.'}
          </p>
        </div>

        <form onSubmit={submit} className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(16,24,40,0.04)] p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-rose-50 ring-1 ring-inset ring-rose-200 px-3 py-2.5 text-[13px] text-rose-800" role="alert">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
          <input type="text" autoComplete="username" value={user.email} readOnly hidden />
          <PasswordInput
            id="current"
            label={forced ? 'Temporary password' : 'Current password'}
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            autoFocus
          />
          <PasswordInput id="new" label="New password" value={next} onChange={setNext} autoComplete="new-password" />
          <PasswordInput id="confirm" label="Repeat the new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />

          <ul className="space-y-1 text-[12.5px]" aria-label="Password rules">
            {checks.map((c) => (
              <li key={c.text} className={`flex items-center gap-1.5 ${c.ok ? 'text-emerald-700' : 'text-slate-500'}`}>
                <Check className={`w-3.5 h-3.5 ${c.ok ? 'opacity-100' : 'opacity-30'}`} />
                {c.text}
              </li>
            ))}
          </ul>

          <button
            type="submit"
            disabled={busy || !valid}
            className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 text-white text-[14px] font-medium shadow-sm hover:bg-slate-800 disabled:opacity-50 transition"
          >
            {busy ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-label="Saving" /> : 'Save password'}
          </button>
        </form>

        <div className="mt-5 text-center">
          {forced ? (
            <button type="button" onClick={signOut} className="text-[13px] font-medium text-slate-500 hover:text-slate-800">
              Sign out
            </button>
          ) : (
            <Link href={homeFor(user.permissions, !!user.employee)} className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-500 hover:text-slate-800">
              <ArrowLeft className="w-4 h-4" /> Back
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
