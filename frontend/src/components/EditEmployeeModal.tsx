'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Save, Loader2, AlertCircle, UserCheck } from 'lucide-react';
import { useShell } from '@/components/shell/ShellContext';
import { api } from '@/lib/api';

interface EditEmployeeModalProps {
  employee: any;
  onClose: () => void;
  onUpdated: (employee: any) => void;
}

const inputClass =
  'w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white transition';

export function EditEmployeeModal({ employee, onClose, onUpdated }: EditEmployeeModalProps) {
  const canManageSetup = useShell().can('setup.manage');
  const [options, setOptions] = useState<{ departments: any[]; workSchedules: any[] } | null>(null);
  const [form, setForm] = useState({
    fullName: employee.fullName || '',
    employeeCode: employee.employeeCode || '',
    email: employee.email || '',
    phoneNumber: employee.phoneNumber || '',
    jobTitle: employee.jobTitle || '',
    departmentId: employee.departmentId || employee.department?.id || '',
    workScheduleId: employee.workScheduleId || employee.workSchedule?.id || '',
    assignedZone: employee.assignedZone || '',
    employmentType: employee.employmentType || 'Full-Time',
    isActive: employee.isActive ?? true,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getEmployeeFormOptions()
      .then((res) => {
        setOptions(res.data);
      })
      .catch((e) => setError(e.message));
  }, []);

  const handleChange = (k: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const val = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value;
    setForm((prev) => ({ ...prev, [k]: val }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fullName.trim() || !form.employeeCode.trim()) {
      setError('Full Name and Employee ID are required');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const payload: Record<string, any> = {
        fullName: form.fullName.trim(),
        employeeCode: form.employeeCode.trim(),
        email: form.email.trim() || null,
        phoneNumber: form.phoneNumber.trim() || null,
        jobTitle: form.jobTitle.trim() || 'Team Member',
        departmentId: form.departmentId || null,
        workScheduleId: form.workScheduleId || null,
        assignedZone: form.assignedZone.trim() || null,
        employmentType: form.employmentType || 'Full-Time',
        isActive: Boolean(form.isActive),
      };

      const res = await api.updateEmployee(employee.id, payload);
      if (res.success && res.data) {
        onUpdated(res.data);
      } else {
        throw new Error('Failed to update employee details');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while saving employee details');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[92vh] overflow-y-auto border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs">
              <UserCheck className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Edit Employee Details</h3>
              <p className="text-[11px] text-slate-500">
                Updating profile for <span className="font-semibold text-slate-800">{employee.fullName}</span> ({employee.employeeCode})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1.5 rounded-lg hover:bg-slate-200/50 transition"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Full Name *</span>
            <input
              required
              value={form.fullName}
              onChange={handleChange('fullName')}
              className={inputClass}
              placeholder="e.g. John Doe"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Employee ID / Code *</span>
            <input
              required
              value={form.employeeCode}
              onChange={handleChange('employeeCode')}
              className={inputClass}
              placeholder="e.g. EMP-001 or 22IT0512"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Email Address</span>
            <input
              type="email"
              value={form.email}
              onChange={handleChange('email')}
              className={inputClass}
              placeholder="e.g. john@worksight.io"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Phone Number</span>
            <input
              type="tel"
              value={form.phoneNumber}
              onChange={handleChange('phoneNumber')}
              className={inputClass}
              placeholder="e.g. +1 555-0199"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Job Title / Designation</span>
            <input
              value={form.jobTitle}
              onChange={handleChange('jobTitle')}
              className={inputClass}
              placeholder="e.g. Senior Software Engineer"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Department</span>
            <select
              value={form.departmentId}
              onChange={handleChange('departmentId')}
              className={inputClass}
            >
              <option value="">Select Department...</option>
              {options?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="flex items-center justify-between gap-2 font-semibold text-slate-700">
              <span>Work Schedule</span>
              {canManageSetup && (
                <Link href="/dashboard/settings?tab=work-hours" onClick={onClose} className="font-medium text-blue-600 hover:text-blue-700">
                  Manage
                </Link>
              )}
            </span>
            <select
              value={form.workScheduleId}
              onChange={handleChange('workScheduleId')}
              className={inputClass}
            >
              <option value="">None (Flexible / No Late Penalty)</option>
              {options?.workSchedules.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.startTime} – {w.endTime})
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Assigned Office Zone</span>
            <input
              value={form.assignedZone}
              onChange={handleChange('assignedZone')}
              className={inputClass}
              placeholder="e.g. Main Workstation Area"
            />
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Employment Type</span>
            <select
              value={form.employmentType}
              onChange={handleChange('employmentType')}
              className={inputClass}
            >
              <option value="Full-Time">Full-Time</option>
              <option value="Part-Time">Part-Time</option>
              <option value="Contract">Contract</option>
              <option value="Intern">Intern</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="font-semibold text-slate-700">Account Status</span>
            <select
              value={form.isActive ? 'true' : 'false'}
              onChange={(e) => setForm((prev) => ({ ...prev, isActive: e.target.value === 'true' }))}
              className={inputClass}
            >
              <option value="true">Active (Allowed Presence Tracking)</option>
              <option value="false">Inactive / Suspended</option>
            </select>
          </label>

          {error && (
            <div className="sm:col-span-2 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 flex items-start gap-2 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-6 py-4 border-t border-slate-100 flex flex-wrap items-center justify-end gap-2.5 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2 shadow-xs transition"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Changes
          </button>
        </div>
      </form>
    </div>
  );
}
