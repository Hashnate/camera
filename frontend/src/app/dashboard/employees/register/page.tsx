'use client';

/**
 * Add employee: a standard two-step flow.
 *   1. Details form (sections, required fields marked, inline validation, nothing pre-chosen for you).
 *   2. After saving, optionally enrol the face in the same dialog used on the Employees page
 *      (webcam, upload, or the employee's own phone via QR code).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, CheckCircle2, ScanFace, UserPlus } from 'lucide-react';
import { Header } from '@/components/Header';
import { FaceEnrollModal } from '@/components/FaceEnrollModal';
import { useShell } from '@/components/shell/ShellContext';
import { api } from '@/lib/api';
import { Card, btn } from '@/components/ui';

interface Options {
  departments: { id: string; name: string }[];
  workSchedules: { id: string; name: string; startTime: string; endTime: string }[];
  zones: { id: string; name: string }[];
  designationsByDepartment: Record<string, string[]>;
}

const EMPLOYMENT_TYPES = ['Full-Time', 'Part-Time', 'Contract', 'Intern'];
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY = {
  fullName: '',
  employeeCode: '',
  email: '',
  phoneNumber: '',
  departmentId: '',
  jobTitle: '',
  employmentType: 'Full-Time',
  joiningDate: today(),
  workScheduleId: '',
  assignedZone: '',
  isActive: true,
};
type Form = typeof EMPTY;
type Errors = Partial<Record<keyof Form, string>>;

const inputBase =
  'w-full h-10 rounded-lg bg-white px-3 text-[14px] text-slate-900 placeholder-slate-400 ring-1 ring-inset focus:outline-none focus:ring-2 focus:ring-blue-600 transition disabled:bg-slate-50';

function inputClass(error?: string) {
  return `${inputBase} ${error ? 'ring-rose-300 bg-rose-50/30' : 'ring-slate-200'}`;
}

function Field({
  id,
  label,
  required,
  hint,
  error,
  className = '',
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: React.ReactNode;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[13px] font-medium text-slate-700 mb-1.5">
        {label}
        {required ? <span className="text-rose-600"> *</span> : <span className="font-normal text-slate-400"> (optional)</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[12px] text-rose-600 flex items-center gap-1">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[12px] text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-4 px-5 sm:px-6 py-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <div>
        <h2 className="text-[14px] font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-[12.5px] text-slate-500">{description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function validate(f: Form): Errors {
  const e: Errors = {};
  if (f.fullName.trim().length < 2) e.fullName = 'Enter the employee’s full name.';
  if (!f.employeeCode.trim()) e.employeeCode = 'Enter an employee ID.';
  else if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(f.employeeCode.trim())) e.employeeCode = 'Use letters, numbers, - . / or _ only.';
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.';
  if (f.phoneNumber.trim() && !/^[+\d][\d\s()-]{6,}$/.test(f.phoneNumber.trim())) e.phoneNumber = 'Enter a valid phone number.';
  if (!f.departmentId) e.departmentId = 'Choose a department.';
  if (!f.jobTitle.trim()) e.jobTitle = 'Enter a job title.';
  return e;
}

export default function AddEmployeePage() {
  const router = useRouter();
  const canManageSetup = useShell().can('setup.manage');
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [options, setOptions] = useState<Options | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; fullName: string; employeeCode: string } | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [faceSaved, setFaceSaved] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    api
      .getEmployeeFormOptions()
      .then((res) => setOptions({ zones: [], designationsByDepartment: {}, ...(res.data as any) }))
      .catch((e) => setOptionsError(e.message || 'Could not load departments and schedules'));
  }, []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const deptName = options?.departments.find((d) => d.id === form.departmentId)?.name;
  const titleSuggestions = useMemo(
    () => (deptName && options?.designationsByDepartment[deptName]) || Object.values(options?.designationsByDepartment ?? {}).flat(),
    [deptName, options]
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const found = validate(form);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      formRef.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
      return;
    }
    try {
      setSubmitting(true);
      const res = await api.createEmployee({
        fullName: form.fullName.trim(),
        employeeCode: form.employeeCode.trim().toUpperCase(),
        email: form.email.trim() || undefined,
        phoneNumber: form.phoneNumber.trim() || undefined,
        departmentId: form.departmentId,
        jobTitle: form.jobTitle.trim(),
        employmentType: form.employmentType,
        joiningDate: form.joiningDate || undefined,
        workScheduleId: form.workScheduleId || undefined,
        assignedZone: form.assignedZone || undefined,
        isActive: form.isActive,
      });
      setCreated({ id: res.data.id, fullName: res.data.fullName, employeeCode: res.data.employeeCode });
      window.scrollTo({ top: 0 });
    } catch (err: any) {
      const msg: string = err.message || 'Could not add the employee.';
      if (/already exists/i.test(msg)) {
        setErrors((x) => ({ ...x, employeeCode: 'This employee ID is already used by someone else.' }));
        formRef.current?.querySelector<HTMLElement>('#employeeCode')?.focus();
      } else {
        setServerError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const addAnother = () => {
    setForm({ ...EMPTY, joiningDate: today() });
    setErrors({});
    setCreated(null);
    setFaceSaved(false);
  };

  // ------------------------------------------------------------ step 2: saved
  if (created) {
    const firstName = created.fullName.split(' ')[0];
    return (
      <>
        <Header title="Add employee" subtitle="Step 2 of 2 · face enrolment" />
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-8 w-full max-w-2xl mx-auto">
          <Card className="p-6 sm:p-8 text-center">
            <span className="mx-auto w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7" />
            </span>
            <h2 className="mt-4 text-[18px] font-semibold text-slate-900">{created.fullName} was added</h2>
            <p className="mt-1 text-[13.5px] text-slate-500">
              Employee ID <span className="font-mono text-slate-700">{created.employeeCode}</span>
            </p>

            <div className="mt-6 rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200 p-4 text-left flex items-start gap-3">
              <ScanFace className="w-5 h-5 mt-0.5 text-blue-600 shrink-0" />
              <div className="text-[13px]">
                {faceSaved ? (
                  <p className="text-slate-700">
                    <b className="font-semibold text-emerald-700">Face enrolled.</b> The cameras can now recognise {firstName} and record attendance.
                  </p>
                ) : (
                  <p className="text-slate-700">
                    <b className="font-semibold">Next: enrol {firstName}&apos;s face</b> so the cameras can recognise them. Use this computer&apos;s webcam,
                    upload photos, or show a QR code so they can take the photos on their own phone.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse sm:flex-row gap-2 sm:justify-center">
              <button type="button" onClick={addAnother} className={btn.secondary}>
                <UserPlus className="w-4 h-4" /> Add another
              </button>
              {faceSaved ? (
                <Link href="/dashboard/employees" className={btn.primary}>
                  Done
                </Link>
              ) : (
                <>
                  <Link href="/dashboard/employees" className={btn.secondary}>
                    Skip for now
                  </Link>
                  <button type="button" onClick={() => setEnrolling(true)} className={btn.primary}>
                    <ScanFace className="w-4 h-4" /> Enrol face now
                  </button>
                </>
              )}
            </div>
          </Card>
        </main>

        {enrolling && (
          <FaceEnrollModal
            employee={created}
            maxSamples={5}
            onClose={() => setEnrolling(false)}
            onChanged={() => setFaceSaved(true)}
          />
        )}
      </>
    );
  }

  // ------------------------------------------------------------ step 1: details
  return (
    <>
      <Header title="Add employee" subtitle="Step 1 of 2 · employee details" />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 w-full max-w-5xl mx-auto">
        <Link href="/dashboard/employees" className="inline-flex items-center gap-1.5 mb-4 text-[13px] font-medium text-slate-500 hover:text-slate-900">
          <ArrowLeft className="w-4 h-4" /> Employees
        </Link>

        {(optionsError || serverError) && (
          <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-rose-50 ring-1 ring-inset ring-rose-200 px-4 py-3 text-[13px] text-rose-800" role="alert">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {serverError || optionsError}
          </div>
        )}

        <form ref={formRef} onSubmit={submit} noValidate>
          <Card className="divide-y divide-slate-100">
            <Section title="Basic details" description="Who they are and how to reach them.">
              <Field id="fullName" label="Full name" required error={errors.fullName} className="sm:col-span-2">
                <input
                  id="fullName"
                  autoComplete="off"
                  value={form.fullName}
                  onChange={(e) => set('fullName', e.target.value)}
                  aria-invalid={!!errors.fullName}
                  aria-describedby={errors.fullName ? 'fullName-error' : undefined}
                  className={inputClass(errors.fullName)}
                />
              </Field>
              <Field id="employeeCode" label="Employee ID" required hint="Must be unique, e.g. EMP-0012" error={errors.employeeCode}>
                <input
                  id="employeeCode"
                  autoComplete="off"
                  value={form.employeeCode}
                  onChange={(e) => set('employeeCode', e.target.value)}
                  onBlur={(e) => set('employeeCode', e.target.value.trim().toUpperCase())}
                  aria-invalid={!!errors.employeeCode}
                  className={`${inputClass(errors.employeeCode)} font-mono`}
                />
              </Field>
              <Field id="email" label="Work email" error={errors.email}>
                <input
                  id="email"
                  type="email"
                  autoComplete="off"
                  placeholder="name@company.com"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  aria-invalid={!!errors.email}
                  className={inputClass(errors.email)}
                />
              </Field>
              <Field id="phoneNumber" label="Phone" error={errors.phoneNumber}>
                <input
                  id="phoneNumber"
                  type="tel"
                  autoComplete="off"
                  placeholder="+94 7X XXX XXXX"
                  value={form.phoneNumber}
                  onChange={(e) => set('phoneNumber', e.target.value)}
                  aria-invalid={!!errors.phoneNumber}
                  className={inputClass(errors.phoneNumber)}
                />
              </Field>
            </Section>

            <Section title="Job" description="Their role in the organisation.">
              <Field id="departmentId" label="Department" required error={errors.departmentId}>
                <select
                  id="departmentId"
                  value={form.departmentId}
                  onChange={(e) => set('departmentId', e.target.value)}
                  disabled={!options}
                  aria-invalid={!!errors.departmentId}
                  className={inputClass(errors.departmentId)}
                >
                  <option value="">{options ? 'Choose a department' : 'Loading…'}</option>
                  {options?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="jobTitle" label="Job title" required error={errors.jobTitle}>
                <input
                  id="jobTitle"
                  list="job-title-suggestions"
                  autoComplete="off"
                  value={form.jobTitle}
                  onChange={(e) => set('jobTitle', e.target.value)}
                  aria-invalid={!!errors.jobTitle}
                  className={inputClass(errors.jobTitle)}
                />
                <datalist id="job-title-suggestions">
                  {titleSuggestions.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
              <Field id="employmentType" label="Employment type" required>
                <select id="employmentType" value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)} className={inputClass()}>
                  {EMPLOYMENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace('-', ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="joiningDate" label="Start date">
                <input id="joiningDate" type="date" value={form.joiningDate} onChange={(e) => set('joiningDate', e.target.value)} className={inputClass()} />
              </Field>
            </Section>

            <Section title="Schedule & location" description="Used to mark late arrivals and to group people by area.">
              <Field
                id="workScheduleId"
                label="Working hours"
                hint={
                  <>
                    Arrivals after the start time are marked late.{' '}
                    {canManageSetup && (
                      <Link href="/dashboard/settings?tab=work-hours" className="font-medium text-blue-600 hover:text-blue-700">
                        Edit schedules in Settings →
                      </Link>
                    )}
                  </>
                }
              >
                <select
                  id="workScheduleId"
                  value={form.workScheduleId}
                  onChange={(e) => set('workScheduleId', e.target.value)}
                  disabled={!options}
                  className={inputClass()}
                >
                  <option value="">No fixed hours</option>
                  {options?.workSchedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.startTime} – {s.endTime})
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="assignedZone" label="Work area">
                <select id="assignedZone" value={form.assignedZone} onChange={(e) => set('assignedZone', e.target.value)} disabled={!options} className={inputClass()}>
                  <option value="">Not set</option>
                  {options?.zones.map((z) => (
                    <option key={z.id} value={z.name}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </Field>
            </Section>

            <Section title="Status" description="Inactive employees are kept on record but not tracked.">
              <label className="sm:col-span-2 flex items-start gap-3 cursor-pointer select-none">
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.isActive}
                  onClick={() => set('isActive', !form.isActive)}
                  className={`mt-0.5 relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${form.isActive ? 'bg-blue-600' : 'bg-slate-300'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${form.isActive ? 'translate-x-4' : ''}`} />
                </button>
                <span>
                  <span className="block text-[13.5px] font-medium text-slate-900">{form.isActive ? 'Active' : 'Inactive'}</span>
                  <span className="block text-[12.5px] text-slate-500">
                    {form.isActive ? 'Attendance is recorded once their face is enrolled.' : 'The cameras will ignore this person.'}
                  </span>
                </span>
              </label>
            </Section>

            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 px-5 sm:px-6 py-4 bg-slate-50/60 rounded-b-2xl">
              <button type="button" onClick={() => router.push('/dashboard/employees')} className={btn.secondary} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className={btn.primary} disabled={submitting || !options}>
                {submitting ? (
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-label="Saving" />
                ) : (
                  <UserPlus className="w-4 h-4" />
                )}
                Add employee
              </button>
            </div>
          </Card>
        </form>
      </main>
    </>
  );
}
