'use client';

/** Small form pieces shared by the Settings page sections. */

import React from 'react';
import { AlertCircle, Check, X } from 'lucide-react';

export const inputBase =
  'h-9 rounded-lg bg-white px-3 text-[13.5px] text-slate-900 placeholder-slate-400 ring-1 ring-inset ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-600 transition disabled:bg-slate-50 disabled:text-slate-500';

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
        checked ? 'bg-blue-600' : 'bg-slate-300'
      }`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

export type Tone = 'emerald' | 'amber' | 'rose' | 'slate';

export function StatusText({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const dot = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', slate: 'bg-slate-300' }[tone];
  const text = { emerald: 'text-emerald-700', amber: 'text-amber-800', rose: 'text-rose-700', slate: 'text-slate-500' }[tone];
  return (
    <span className={`inline-flex max-w-full min-w-0 items-center gap-1.5 text-[12.5px] ${text}`} title={typeof children === 'string' ? children : undefined}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function Notice({ tone, children, onClose }: { tone: 'error' | 'info' | 'success'; children: React.ReactNode; onClose?: () => void }) {
  const cls =
    tone === 'error'
      ? 'bg-rose-50 text-rose-800 ring-rose-200'
      : tone === 'success'
      ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
      : 'bg-slate-50 text-slate-700 ring-slate-200';
  const Icon = tone === 'success' ? Check : AlertCircle;
  return (
    <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px] ring-1 ring-inset ${cls}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/** Label + control + optional help line. */
export function Field({
  id,
  label,
  optional,
  help,
  className = '',
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  help?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[13px] font-medium text-slate-700 mb-1.5">
        {label}
        {optional && <span className="font-normal text-slate-400"> (optional)</span>}
      </label>
      {children}
      {help && <p className="mt-1.5 text-[12px] text-slate-500">{help}</p>}
    </div>
  );
}
