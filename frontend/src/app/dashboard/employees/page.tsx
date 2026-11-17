'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Search,
  Building2,
  CheckCircle2,
  ScanFace,
  UserPlus,
  Clock,
  Edit3,
  Trash2,
  XCircle,
  AlertCircle,
  Check,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { api, FaceEnrollmentSummary } from '@/lib/api';
import { FaceEnrollModal } from '@/components/FaceEnrollModal';
import { AddEmployeeModal } from '@/components/AddEmployeeModal';
import { EditEmployeeModal } from '@/components/EditEmployeeModal';
import { DeleteEmployeeModal } from '@/components/DeleteEmployeeModal';

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [faces, setFaces] = useState<Record<string, FaceEnrollmentSummary>>({});
  const [maxSamples, setMaxSamples] = useState(5);
  const [enrolling, setEnrolling] = useState<any | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  const fetchFaces = async () => {
    try {
      const res = await api.getFaceEnrollments();
      setFaces(Object.fromEntries(res.data.map((f) => [f.employeeId, f])));
      setMaxSamples(res.maxSamples);
    } catch (err) {
      console.error('Failed to load biometric enrollments:', err);
    }
  };

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const res = await api.getEmployees();
      if (res.success && res.data) {
        setEmployees(res.data);
      }
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

  const enrolledCount = Object.keys(faces).length;

  const filtered = employees.filter(
    (e) =>
      e.fullName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.employeeCode?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.department?.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.jobTitle?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <>
      <Header
        title="Employee Directory & Roster"
        subtitle="Manage registered employees, update details, biometric enrollments, and status"
      />

      <main className="p-8 space-y-6">
        {/* Toast feedback */}
        {toast && (
          <div
            className={`p-3.5 rounded-xl border flex items-center justify-between text-xs font-semibold animate-in fade-in slide-in-from-top-2 duration-200 ${
              toast.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {toast.type === 'success' ? (
                <Check className="w-4 h-4 text-emerald-600" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600" />
              )}
              <span>{toast.message}</span>
            </div>
            <button
              onClick={() => setToast(null)}
              className="text-slate-400 hover:text-slate-700 ml-3"
            >
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by name, ID, job title, department..."
              className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-500 font-medium">
              Total: {employees.length} Employees
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 px-2 py-1 rounded-md border border-emerald-200 font-medium">
              <ScanFace className="w-3.5 h-3.5" /> {enrolledCount} Active Enrolled
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded-md border border-amber-200 font-medium">
              <Clock className="w-3.5 h-3.5" /> {Math.max(0, employees.length - enrolledCount)} Pending
            </span>
            <Link
              href="/dashboard/employees/register"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 ml-auto shadow-xs transition"
            >
              <UserPlus className="w-4 h-4" /> Register New Employee
            </Link>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3.5 px-4">Employee</th>
                <th className="py-3.5 px-4">Employee ID</th>
                <th className="py-3.5 px-4">Department & Role</th>
                <th className="py-3.5 px-4">Schedule</th>
                <th className="py-3.5 px-4">Assigned Area</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Biometrics</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    Loading employee directory...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    No employees matching search criteria
                  </td>
                </tr>
              ) : (
                filtered.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center font-bold text-slate-700 text-xs shrink-0">
                          {emp.fullName ? emp.fullName.substring(0, 2).toUpperCase() : 'EM'}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{emp.fullName}</p>
                          <p className="text-[11px] text-slate-400">{emp.email || 'No email registered'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono font-medium text-slate-700">{emp.employeeCode}</td>
                    <td className="py-3 px-4">
                      <div>
                        <span className="inline-flex items-center gap-1.5 text-slate-700 font-medium">
                          <Building2 className="w-3.5 h-3.5 text-slate-400" />
                          {emp.department?.name || 'General'}
                        </span>
                        <p className="text-[11px] text-slate-400 pl-5">{emp.jobTitle || 'Team Member'}</p>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-slate-600 font-mono text-[11px]">
                        {emp.workSchedule?.startTime || '09:00'} - {emp.workSchedule?.endTime || '17:00'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{emp.assignedZone || 'Main Hall'}</td>
                    <td className="py-3 px-4">
                      {emp.isActive ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <CheckCircle2 className="w-3 h-3" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        {faces[emp.id] && faces[emp.id].samples > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <ScanFace className="w-3.5 h-3.5" /> Enrolled ({faces[emp.id].samples})
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                            <Clock className="w-3 h-3" /> PENDING
                          </span>
                        )}
                        <button
                          onClick={() => setEnrolling(emp)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border bg-white text-slate-700 border-slate-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition shadow-2xs"
                          title="Manage facial biometrics"
                        >
                          <ScanFace className="w-3.5 h-3.5 text-blue-600" />
                          <span>{faces[emp.id] && faces[emp.id].samples > 0 ? 'Update Face' : 'Enrol Face'}</span>
                        </button>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setEditing(emp)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 border border-transparent transition"
                          title="Edit employee details"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>
                        <button
                          onClick={() => setDeleting(emp)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold text-rose-600 bg-rose-50 hover:bg-rose-100 hover:text-rose-700 border border-rose-200 transition"
                          title="Delete employee record"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {/* Modals */}
      {adding && (
        <AddEmployeeModal
          onClose={() => setAdding(false)}
          onCreated={(emp) => {
            setAdding(false);
            fetchEmployees();
            setEnrolling(emp);
            showToast(`Employee ${emp.fullName} registered successfully.`);
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
            showToast(`Employee ${updated.fullName} details updated successfully.`);
          }}
        />
      )}

      {deleting && (
        <DeleteEmployeeModal
          employee={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(id) => {
            setDeleting(null);
            fetchEmployees();
            fetchFaces();
            showToast('Employee and associated biometric records deleted successfully.');
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
            showToast('Biometric face templates updated.');
          }}
        />
      )}
    </>
  );
}
