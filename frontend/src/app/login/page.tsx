'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowRight, Eye, EyeOff, ScanFace } from 'lucide-react';
import { api, setStoredToken } from '@/lib/api';
import { homeFor } from '@/lib/nav';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(email, password);
      if (res.success && res.token) {
        setStoredToken(res.token);
        // A new account or a reset password must be replaced first; otherwise go to the first page they can open.
        router.push(res.user.mustChangePassword ? '/change-password' : homeFor(res.user.permissions, !!res.user.employee));
      } else {
        setError('Sign-in failed. Please try again.');
      }
    } catch (err: any) {
      setError(err.message || 'Email or password is incorrect.');
    } finally {
      setLoading(false);
    }
  };

  const field =
    'w-full h-10 rounded-lg bg-white px-3 text-[14px] text-slate-900 placeholder-slate-400 ring-1 ring-inset ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-600 transition';

  return (
    <div className="min-h-screen bg-[#f6f7f9] flex flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <span className="w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-md shadow-blue-600/25">
            <ScanFace className="w-6 h-6" />
          </span>
          <h1 className="mt-4 text-[22px] font-semibold tracking-tight text-slate-900">Sign in to WorkSight</h1>
          <p className="mt-1 text-[13.5px] text-slate-500">Attendance and office time from your cameras</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-[0_1px_2px_rgba(16,24,40,0.04)] p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-rose-50 ring-1 ring-inset ring-rose-200 px-3 py-2.5 text-[13px] text-rose-800" role="alert">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-[13px] font-medium text-slate-700 mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className={field}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-[13px] font-medium text-slate-700 mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${field} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-400 hover:text-slate-700"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 text-white text-[14px] font-medium shadow-sm hover:bg-slate-800 disabled:opacity-60 transition"
          >
            {loading ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-label="Signing in" />
            ) : (
              <>
                Sign in <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
          <p className="text-center text-[12.5px] text-slate-500">Forgot your password? Ask your admin to reset it.</p>
        </form>
      </div>
    </div>
  );
}
