'use client';

import React, { useState } from 'react';
import { Trash2, AlertTriangle, X, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

interface DeleteEmployeeModalProps {
  employee: any;
  onClose: () => void;
  onDeleted: (employeeId: string) => void;
}

export function DeleteEmployeeModal({ employee, onClose, onDeleted }: DeleteEmployeeModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [confirmChecked, setConfirmChecked] = useState(false);

  const isMatching = confirmCode.trim().toLowerCase() === employee.employeeCode.trim().toLowerCase();
  const canDelete = isMatching || confirmChecked;

  const handleDelete = async () => {
    if (!canDelete) {
      setError(`Please check the confirmation box or type "${employee.employeeCode}" to confirm.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteEmployee(employee.id);
      if (res.success) {
        onDeleted(employee.id);
      } else {
        throw new Error(res.message || 'Failed to delete employee');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while deleting the employee');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[92vh] overflow-y-auto border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-rose-50/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center font-bold">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Delete Employee</h3>
              <p className="text-[11px] text-slate-500">Permanent removal of employee profile</p>
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

        {/* Content */}
        <div className="p-4 sm:p-6 space-y-4 text-xs">
          <div className="p-3 bg-slate-50 border border-slate-200/70 rounded-lg flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-200 text-slate-700 font-bold flex items-center justify-center text-sm shrink-0">
              {employee.fullName.substring(0, 2).toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900">{employee.fullName}</p>
              <p className="text-[11px] text-slate-500 font-mono">
                ID: {employee.employeeCode} &bull; {employee.department?.name || 'No Dept'}
              </p>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200/80 text-rose-800 text-[11px] space-y-1.5 leading-relaxed">
            <p className="font-semibold flex items-center gap-1.5 text-rose-900">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Warning: Irreversible Action
            </p>
            <p>
              Deleting this employee will automatically revoke and remove all enrolled biometric face templates,
              daily tracking sessions, zone intervals, and attendance history associated with this profile.
            </p>
          </div>

          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-700 font-medium block">
                Type employee code{' '}
                <span className="font-mono font-bold text-slate-900 bg-slate-100 px-1 py-0.5 rounded border border-slate-200">
                  {employee.employeeCode}
                </span>{' '}
                below:
              </label>
              <button
                type="button"
                onClick={() => setConfirmCode(employee.employeeCode)}
                className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 hover:underline"
              >
                Auto-fill Code
              </button>
            </div>
            <input
              type="text"
              value={confirmCode}
              onChange={(e) => setConfirmCode(e.target.value)}
              placeholder={`Type ${employee.employeeCode} to confirm`}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 placeholder-slate-400 focus:outline-none focus:border-rose-500 focus:bg-white transition"
              autoFocus
            />

            <div className="pt-2 flex items-start gap-2">
              <input
                type="checkbox"
                id="delete_confirm_check"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500 cursor-pointer"
              />
              <label
                htmlFor="delete_confirm_check"
                className="text-[11px] text-slate-700 cursor-pointer select-none leading-tight"
              >
                I confirm that I want to permanently delete <strong>{employee.fullName}</strong> ({employee.employeeCode}) and revoke all biometrics.
              </label>
            </div>
          </div>

          {error && (
            <div className="p-2.5 rounded-lg bg-rose-100 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-6 py-4 border-t border-slate-100 flex flex-wrap items-center justify-end gap-2.5 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:bg-slate-100 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className={`px-4 py-2 rounded-lg text-white text-xs font-semibold inline-flex items-center gap-2 shadow-xs transition ${
              canDelete
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-rose-400 hover:bg-rose-500 cursor-pointer'
            }`}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Permanently Delete
          </button>
        </div>
      </div>
    </div>
  );
}
