'use client';

import React, { useEffect, useState } from 'react';
import { Search, Building2, CheckCircle2, ScanFace, UserPlus } from 'lucide-react';
import { Header } from '@/components/Header';
import { api, FaceEnrollmentSummary } from '@/lib/api';
import { FaceEnrollModal } from '@/components/FaceEnrollModal';
import { AddEmployeeModal } from '@/components/AddEmployeeModal';

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [faces, setFaces] = useState<Record<string, FaceEnrollmentSummary>>({});
  const [maxSamples, setMaxSamples] = useState(5);
  const [enrolling, setEnrolling] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);

  const fetchFaces = async () => {
    try {
      const res = await api.getFaceEnrollments();
      setFaces(Object.fromEntries(res.data.map((f) => [f.employeeId, f])));
      setMaxSamples(res.maxSamples);
    } catch (err) {
      console.error(err);
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
      console.error(err);
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
      e.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.employeeCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.department?.name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <>
      <Header
        title="Employee Directory & Roster"
        subtitle="Manage registered employees, assigned departments, and work schedules"
      />

      <main className="p-8 space-y-6">
        {/* Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm">
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by name, ID or department..."
              className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 font-medium">
              Total: {employees.length} Employees
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-blue-700 font-medium">
              <ScanFace className="w-3.5 h-3.5" /> {enrolledCount} enrolled for auto-attendance
            </span>
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
            >
              <UserPlus className="w-4 h-4" /> Add employee
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3.5 px-4">Employee</th>
                <th className="py-3.5 px-4">Employee ID</th>
                <th className="py-3.5 px-4">Department</th>
                <th className="py-3.5 px-4">Schedule</th>
                <th className="py-3.5 px-4">Assigned Area</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Face ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    Loading employee directory...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    No employees matching search criteria
                  </td>
                </tr>
              ) : (
                filtered.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center font-bold text-slate-600 text-xs">
                          {emp.fullName.substring(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{emp.fullName}</p>
                          <p className="text-[11px] text-slate-400">{emp.email || 'No email registered'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600">{emp.employeeCode}</td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1.5 text-slate-700 font-medium">
                        <Building2 className="w-3.5 h-3.5 text-slate-400" />
                        {emp.department?.name || 'General'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-slate-600">
                        {emp.workSchedule?.startTime || '09:00'} - {emp.workSchedule?.endTime || '17:00'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{emp.assignedZone || 'Main Hall'}</td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <CheckCircle2 className="w-3 h-3" /> Active
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => setEnrolling(emp)}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border ${
                          faces[emp.id]
                            ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <ScanFace className="w-3.5 h-3.5" />
                        {faces[emp.id] ? `Enrolled (${faces[emp.id].samples})` : 'Enrol face'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {adding && (
        <AddEmployeeModal
          onClose={() => setAdding(false)}
          onCreated={(emp) => {
            setAdding(false);
            fetchEmployees();
            setEnrolling(emp); // go straight to face enrolment
          }}
        />
      )}

      {enrolling && (
        <FaceEnrollModal
          employee={enrolling}
          enrollment={faces[enrolling.id]}
          maxSamples={maxSamples}
          onClose={() => setEnrolling(null)}
          onChanged={fetchFaces}
        />
      )}
    </>
  );
}

