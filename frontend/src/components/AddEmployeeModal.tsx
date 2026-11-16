'use client';

import React, { useEffect, useState } from 'react';
import { X, UserPlus, Loader2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

interface Props {
  onClose: () => void;
  /** Called with the created employee so the caller can go straight to face enrolment. */
  onCreated: (employee: any) => void;
}

const field =
  'w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500';

export function AddEmployeeModal({ onClose, onCreated }: Props) {
  const [options, setOptions] = useState<{ departments: any[]; workSchedules: any[] } | null>(null);
  const [form, setForm] = useState({
    employeeCode: '',
    fullName: '',
    email: '',
    jobTitle: '',
    departmentId: '',
    workScheduleId: '',
    assignedZone: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getEmployeeFormOptions()
      .then((res) => {
        setOptions(res.data);
        setForm((f) => ({
          ...f,
          departmentId: res.data.departments[0]?.id ?? '',
          workScheduleId: res.data.workSchedules[0]?.id ?? '',
        }));
      })
      .catch((e) => setError(e.message));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      Object.entries(form).forEach(([k, v]) => v.trim() && (payload[k] = v.trim()));
      const res = await api.createEmployee(payload);
      onCreated(res.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">Add employee</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label className="space-y-1">
            <span className="font-semibold text-slate-600">Full name *</span>
            <input required value={form.fullName} onChange={set('fullName')} className={field} placeholder="Jane Perera" />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600">Employee ID *</span>
            <input required value={form.employeeCode} onChange={set('employeeCode')} className={field} placeholder="EMP-106" />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600">Email</span>
            <input type="email" value={form.email} onChange={set('email')} className={field} placeholder="jane@company.com" />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600">Job title</span>
            <input value={form.jobTitle} onChange={set('jobTitle')} className={field} placeholder="Team Member" />
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600">Department *</span>
            <select required value={form.departmentId} onChange={set('departmentId')} className={field}>
              {options?.departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-semibold text-slate-600">Work schedule</span>
            <select value={form.workScheduleId} onChange={set('workScheduleId')} className={field}>
              <option value="">None (never marked late)</option>
              {options?.workSchedules.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.startTime}–{w.endTime})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="font-semibold text-slate-600">Assigned area</span>
            <input value={form.assignedZone} onChange={set('assignedZone')} className={field} placeholder="Main Workstation Area" />
          </label>

          {error && (
            <p className="sm:col-span-2 text-rose-600 flex items-start gap-1.5" role="alert">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !options}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-40 inline-flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            Add & enrol face
          </button>
        </div>
      </form>
    </div>
  );
}
