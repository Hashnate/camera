'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Check, Pencil, ScanFace, Search, Trash2, UserPlus, Users, X } from 'lucide-react';
import { Header } from '@/components/Header';
import { api, FaceEnrollmentSummary } from '@/lib/api';
import { FaceEnrollModal } from '@/components/FaceEnrollModal';
import { AddEmployeeModal } from '@/components/AddEmployeeModal';
import { EditEmployeeModal } from '@/components/EditEmployeeModal';
import { DeleteEmployeeModal } from '@/components/DeleteEmployeeModal';
import { Avatar, Card, EmptyState, PresenceBadge, Skeleton, btn } from '@/components/ui';
import { useShell } from '@/components/shell/ShellContext';

type Filter = 'all' | 'enrolled' | 'needs';

export default function EmployeesPage() {
  const canManage = useShell().can('people.manage');
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [faces, setFaces] = useState<Record<string, FaceEnrollmentSummary>>({});
  const [maxSamples, setMaxSamples] = useState(5);
  const [enrolling, setEnrolling] = useState<any | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchFaces = async () => {
    try {
      const res = await api.getFaceEnrollments();
      setFaces(Object.fromEntries(res.data.map((f) => [f.employeeId, f])));
      setMaxSamples(res.maxSamples);
    } catch (err) {
      console.error('Failed to load face enrolments:', err);
    }
  };

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const res = await api.getEmployees();
      if (res.success && res.data) setEmployees(res.data);
    } catch (err) {
      console.error('Failed to load employees:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEmployees();
    fetchFaces();
  }, []);

  const hasFace = (emp: any) => (faces[emp.id]?.samples ?? 0) > 0;
  const enrolledCount = employees.filter(hasFace).length;
  const needsCount = employees.length - enrolledCount;

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return employees.filter((e) => {
      if (filter === 'enrolled' && !hasFace(e)) return false;
      if (filter === 'needs' && hasFace(e)) return false;
      if (!q) return true;
      return [e.fullName, e.employeeCode, e.department?.name, e.jobTitle, e.email].some((v) => v?.toLowerCase().includes(q));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, faces, filter, searchTerm]);

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: employees.length },
    { key: 'enrolled', label: 'Face enrolled', count: enrolledCount },
    { key: 'needs', label: 'Needs a face', count: needsCount },
  ];

  return (
    <>
      <Header
        actions={
          canManage ? (
            <Link href="/dashboard/employees/register" className={btn.primary}>
              <UserPlus className="w-4 h-4" /> Add employee
            </Link>
          ) : undefined
        }
      />

      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] w-full mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="inline-flex p-1 rounded-xl bg-slate-200/50 ring-1 ring-inset ring-slate-200/70 self-start" role="tablist" aria-label="Filter employees">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={filter === t.key}
                onClick={() => setFilter(t.key)}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium transition ${
                  filter === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
                <span className={`tabular-nums text-[11.5px] ${filter === t.key ? 'text-slate-500' : 'text-slate-400'}`}>{t.count}</span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <label className="relative w-full sm:w-72">
              <span className="sr-only">Search employees</span>
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search name, ID, role…"
                className="w-full h-9 bg-white rounded-lg pl-9 pr-3 text-[13px] text-slate-800 placeholder-slate-400 ring-1 ring-inset ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {canManage && (
              <Link href="/dashboard/employees/register" className={`${btn.primary} md:hidden`} aria-label="Add employee">
                <UserPlus className="w-4 h-4" />
              </Link>
            )}
          </div>
        </div>

        <Card className="overflow-hidden">
          {loading ? (
            <div className="p-5 space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : employees.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No employees yet"
              description="Add your team, then enrol each face so the cameras can record attendance."
              action={
                canManage ? (
                  <Link href="/dashboard/employees/register" className={btn.primary}>
                    <UserPlus className="w-4 h-4" /> Add employee
                  </Link>
                ) : undefined
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState icon={Search} title="No matches" description="Try another name, or clear the filter." />
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="bg-slate-50/70 border-b border-slate-100 text-[11.5px] font-medium text-slate-500">
                <tr>
                  <th className="py-2.5 px-5 font-medium">Employee</th>
                  <th className="py-2.5 px-3 font-medium hidden lg:table-cell">Role</th>
                  <th className="py-2.5 px-3 font-medium hidden xl:table-cell">Hours</th>
                  <th className="py-2.5 px-3 font-medium">Face</th>
                  <th className="py-2.5 px-3 font-medium hidden md:table-cell">Status</th>
                  <th className="py-2.5 px-5 font-medium text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((emp) => {
                  const enrolled = hasFace(emp);
                  return (
                    <tr key={emp.id} className="hover:bg-slate-50/60 transition-colors">
                      <td className="py-3 px-5">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar name={emp.fullName} id={emp.id} />
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900 truncate">{emp.fullName}</p>
                            <p className="text-[12px] text-slate-500 truncate">
                              <span className="font-mono text-[11.5px]">{emp.employeeCode}</span>
                              {emp.email ? ` · ${emp.email}` : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 hidden lg:table-cell">
                        <p className="text-slate-800">{emp.jobTitle || '—'}</p>
                        <p className="text-[12px] text-slate-500">{emp.department?.name || '—'}</p>
                      </td>
                      <td className="py-3 px-3 hidden xl:table-cell text-slate-600 tabular-nums">
                        {emp.workSchedule ? `${emp.workSchedule.startTime} – ${emp.workSchedule.endTime}` : '—'}
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          {enrolled ? <PresenceBadge tone="in">Enrolled</PresenceBadge> : <PresenceBadge tone="away">Needs a face</PresenceBadge>}
                          {canManage && (
                            <button
                              type="button"
                              onClick={() => setEnrolling(emp)}
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[12px] font-medium text-blue-700 hover:bg-blue-50 transition"
                            >
                              <ScanFace className="w-3.5 h-3.5" />
                              {enrolled ? 'Update' : 'Enrol'}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-3 hidden md:table-cell">
                        <span className={`inline-flex items-center gap-1.5 text-[12.5px] ${emp.isActive ? 'text-slate-700' : 'text-slate-400'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${emp.isActive ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                          {emp.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-3 px-5">
                        <div className="flex items-center justify-end gap-1">
                          {canManage && (<>
                          <button
                            type="button"
                            onClick={() => setEditing(emp)}
                            className="p-2 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition"
                            title={`Edit ${emp.fullName}`}
                            aria-label={`Edit ${emp.fullName}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleting(emp)}
                            className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                            title={`Delete ${emp.fullName}`}
                            aria-label={`Delete ${emp.fullName}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          </>)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </main>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-sm" role="status">
          <div
            className={`flex items-center gap-2.5 rounded-xl px-4 py-3 text-[13px] shadow-lg ring-1 ${
              toast.type === 'success' ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-rose-800 ring-rose-200'
            }`}
          >
            {toast.type === 'success' ? <Check className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
            <span>{toast.message}</span>
            <button type="button" onClick={() => setToast(null)} className="ml-2 opacity-60 hover:opacity-100" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {adding && (
        <AddEmployeeModal
          onClose={() => setAdding(false)}
          onCreated={(emp) => {
            setAdding(false);
            fetchEmployees();
            setEnrolling(emp);
            showToast(`${emp.fullName} was added.`);
          }}
        />
      )}

      {editing && (
        <EditEmployeeModal
          employee={editing}
          onClose={() => setEditing(null)}
          onUpdated={(updated) => {
            setEditing(null);
            fetchEmployees();
            showToast(`${updated.fullName} was updated.`);
          }}
        />
      )}

      {deleting && (
        <DeleteEmployeeModal
          employee={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            fetchEmployees();
            fetchFaces();
            showToast('Employee and their face data were deleted.');
          }}
        />
      )}

      {enrolling && (
        <FaceEnrollModal
          employee={enrolling}
          enrollment={faces[enrolling.id]}
          maxSamples={maxSamples}
          onClose={() => setEnrolling(null)}
          onChanged={() => {
            fetchFaces();
            showToast('Face enrolment updated.');
          }}
        />
      )}
    </>
  );
}
