'use client';

/**
 * Settings > Work hours: create, edit, and delete WorkSchedule records (shift start/end times,
 * grace period for late arrivals, and working days).
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { Card, CardHeader, EmptyState, Skeleton, Tag, btn } from '@/components/ui';
import { Field, Notice, inputBase } from '@/components/settings/parts';
import { settingsApi, type WorkSchedule, type WorkSchedulePayload } from '@/lib/api';

type Notify = (message: string, type?: 'success' | 'error') => void;

const WEEKDAYS = [
  { id: '1', short: 'Mon', label: 'Monday' },
  { id: '2', short: 'Tue', label: 'Tuesday' },
  { id: '3', short: 'Wed', label: 'Wednesday' },
  { id: '4', short: 'Thu', label: 'Thursday' },
  { id: '5', short: 'Fri', label: 'Friday' },
  { id: '6', short: 'Sat', label: 'Saturday' },
  { id: '7', short: 'Sun', label: 'Sunday' },
];

const SHORT_BY_ID = Object.fromEntries(WEEKDAYS.map((d) => [d.id, d.short]));

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatShiftLength(start: string, end: string): string | null {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null || e <= s) return null;
  const diff = e - s;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function parseDays(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s in SHORT_BY_ID)
    .sort((a, b) => Number(a) - Number(b));
}

function formatWorkingDays(raw: string): string {
  const days = parseDays(raw);
  if (days.length === 0) return 'No days';
  if (days.length === 7) return 'Every day';
  const nums = days.map(Number);
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  if (contiguous && nums.length >= 3) {
    return `${SHORT_BY_ID[days[0]]}–${SHORT_BY_ID[days[days.length - 1]]}`;
  }
  return days.map((d) => SHORT_BY_ID[d]).join(', ');
}

function ScheduleForm({
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial?: WorkSchedule;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (payload: WorkSchedulePayload) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [startTime, setStartTime] = useState(initial?.startTime ?? '09:00');
  const [endTime, setEndTime] = useState(initial?.endTime ?? '17:00');
  const [graceRaw, setGraceRaw] = useState(String(initial?.graceMinutes ?? 15));
  const [days, setDays] = useState<string[]>(() => parseDays(initial?.workingDays ?? '1,2,3,4,5'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  const timeError =
    startMin === null || endMin === null
      ? 'Enter valid start and end times'
      : endMin <= startMin
      ? 'End time must be after start time'
      : null;

  const graceTrimmed = graceRaw.trim();
  const graceNum = Number(graceTrimmed);
  const graceError =
    graceTrimmed === '' || !Number.isInteger(graceNum) || graceNum < 0 || graceNum > 240
      ? 'Enter a whole number between 0 and 240'
      : null;

  const nameTrimmed = name.trim();
  const nameError = !nameTrimmed ? 'Enter a schedule name' : nameTrimmed.length > 100 ? 'At most 100 characters' : null;
  const daysError = days.length === 0 ? 'Select at least one working day' : null;

  const workingDaysStr = [...days].sort((a, b) => Number(a) - Number(b)).join(',');
  const dirty =
    !initial ||
    nameTrimmed !== initial.name ||
    startTime !== initial.startTime ||
    endTime !== initial.endTime ||
    graceNum !== initial.graceMinutes ||
    workingDaysStr !== parseDays(initial.workingDays).join(',');

  const hasErrors = !!(nameError || timeError || graceError || daysError);
  const durationLabel = formatShiftLength(startTime, endTime);
  const idPrefix = initial ? `ws-${initial.id}` : 'ws-new';

  const toggleDay = (id: string) => {
    setDays((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id].sort((a, b) => Number(a) - Number(b))));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasErrors || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: nameTrimmed,
        startTime,
        endTime,
        graceMinutes: graceNum,
        workingDays: workingDaysStr,
      });
    } catch (err: any) {
      setError(err.message || 'Could not save work schedule');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id={`${idPrefix}-name`} label="Schedule name" className="sm:col-span-2">
          <input
            id={`${idPrefix}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="e.g. Standard Working Hours"
            maxLength={100}
            className={`${inputBase} w-full ${nameError && name !== '' ? 'ring-rose-300' : ''}`}
          />
        </Field>

        <Field id={`${idPrefix}-start`} label="Start time">
          <input
            id={`${idPrefix}-start`}
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            disabled={busy}
            className={`${inputBase} w-full tabular-nums ${timeError ? 'ring-rose-300' : ''}`}
          />
        </Field>

        <Field
          id={`${idPrefix}-end`}
          label="End time"
          help={
            timeError ? (
              <span className="text-rose-600">{timeError}</span>
            ) : durationLabel ? (
              <span>Shift length: {durationLabel}</span>
            ) : undefined
          }
        >
          <input
            id={`${idPrefix}-end`}
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            disabled={busy}
            className={`${inputBase} w-full tabular-nums ${timeError ? 'ring-rose-300' : ''}`}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 items-start">
        <Field
          id={`${idPrefix}-grace`}
          label="Grace period"
          help={
            graceError ? (
              <span className="text-rose-600">{graceError}</span>
            ) : (
              'Arrivals more than this many minutes after start time are marked late (0 = strictly on time).'
            )
          }
        >
          <div className="flex items-center gap-2">
            <input
              id={`${idPrefix}-grace`}
              type="number"
              min={0}
              max={240}
              step={1}
              inputMode="numeric"
              value={graceRaw}
              onChange={(e) => setGraceRaw(e.target.value)}
              disabled={busy}
              className={`${inputBase} w-28 tabular-nums ${graceError ? 'ring-rose-300' : ''}`}
            />
            <span className="text-[13px] text-slate-500">minutes</span>
          </div>
        </Field>

        <div>
          <span className="block text-[13px] font-medium text-slate-700 mb-1.5">Working days</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Working days">
            {WEEKDAYS.map((d) => {
              const active = days.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={active}
                  aria-label={d.label}
                  disabled={busy}
                  onClick={() => toggleDay(d.id)}
                  className={`h-9 px-2.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                    active
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
          {daysError && <p className="mt-1.5 text-[12px] text-rose-600">{daysError}</p>}
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <button type="button" className={btn.secondary} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={btn.primary} disabled={busy || hasErrors || !dirty}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function ScheduleRow({
  schedule,
  canEdit,
  editing,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  schedule: WorkSchedule;
  canEdit: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (payload: WorkSchedulePayload) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const length = formatShiftLength(schedule.startTime, schedule.endTime);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="px-5 sm:px-6 py-4">
      {editing ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13.5px] font-semibold text-slate-900">Edit schedule</h3>
            <span className="text-[12px] text-slate-500 tabular-nums">
              {schedule.employeeCount} {schedule.employeeCount === 1 ? 'employee' : 'employees'} assigned
            </span>
          </div>
          <ScheduleForm initial={schedule} submitLabel="Save changes" onCancel={onCancelEdit} onSubmit={onSave} />
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-semibold text-slate-900">{schedule.name}</h3>
              <Tag tone={schedule.employeeCount > 0 ? 'blue' : 'slate'}>
                <Users className="w-3 h-3 mr-1" />
                {schedule.employeeCount} {schedule.employeeCount === 1 ? 'employee' : 'employees'}
              </Tag>
            </div>
            <p className="text-[13px] text-slate-600 tabular-nums">
              {schedule.startTime} – {schedule.endTime}
              {length ? ` (${length})` : ''}
              <span className="text-slate-300 mx-2">·</span>
              {schedule.graceMinutes === 0 ? 'No grace period' : `${schedule.graceMinutes} min grace`}
              <span className="text-slate-300 mx-2">·</span>
              {formatWorkingDays(schedule.workingDays)}
            </p>
          </div>

          {canEdit && (
            <div className="flex items-center gap-2 shrink-0">
              {confirmDelete ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 px-3 py-1.5 ring-1 ring-inset ring-rose-200">
                  <span className="text-[12.5px] text-rose-800">
                    {schedule.employeeCount > 0
                      ? `${schedule.employeeCount} ${schedule.employeeCount === 1 ? 'employee' : 'employees'} will move to No fixed hours.`
                      : 'Delete this schedule?'}
                  </span>
                  <button type="button" className={btn.secondary} disabled={deleting} onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={handleDelete}
                    className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-rose-600 text-white text-[13px] font-medium hover:bg-rose-700 disabled:opacity-50"
                  >
                    {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Delete
                  </button>
                </div>
              ) : (
                <>
                  <button type="button" className={btn.secondary} onClick={onStartEdit}>
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </button>
                  <button
                    type="button"
                    className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                    aria-label={`Delete ${schedule.name}`}
                    title={`Delete ${schedule.name}`}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkSchedulesTab({ canEdit, notify }: { canEdit: boolean; notify: Notify }) {
  const [schedules, setSchedules] = useState<WorkSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await settingsApi.workSchedules();
      setSchedules(res.data);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Could not load work schedules');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async (payload: WorkSchedulePayload) => {
    const res = await settingsApi.createWorkSchedule(payload);
    setSchedules((prev) => [...(prev ?? []), res.data].sort((a, b) => a.name.localeCompare(b.name)));
    setAdding(false);
    notify(`Work schedule "${res.data.name}" created.`);
  };

  const handleUpdate = async (id: string, payload: WorkSchedulePayload) => {
    const res = await settingsApi.updateWorkSchedule(id, payload);
    setSchedules((prev) =>
      (prev ?? []).map((s) => (s.id === id ? res.data : s)).sort((a, b) => a.name.localeCompare(b.name))
    );
    setEditingId(null);
    notify(`Work schedule "${res.data.name}" updated.`);
  };

  const handleDelete = async (schedule: WorkSchedule) => {
    try {
      await settingsApi.deleteWorkSchedule(schedule.id);
      setSchedules((prev) => (prev ?? []).filter((s) => s.id !== schedule.id));
      if (editingId === schedule.id) setEditingId(null);
      notify(`Work schedule "${schedule.name}" deleted.`);
    } catch (e: any) {
      notify(e.message || 'Could not delete work schedule', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Work schedules"
          description="Define shift start and end times, grace periods for late check-ins, and working days."
          action={
            canEdit && !adding ? (
              <button
                type="button"
                className={btn.primary}
                onClick={() => {
                  setAdding(true);
                  setEditingId(null);
                }}
              >
                <Plus className="w-4 h-4" /> Add schedule
              </button>
            ) : undefined
          }
        />

        {adding && (
          <div className="px-5 sm:px-6 py-5 border-t border-slate-100 bg-slate-50/60">
            <h3 className="text-[13.5px] font-semibold text-slate-900 mb-3">New work schedule</h3>
            <ScheduleForm submitLabel="Create schedule" onCancel={() => setAdding(false)} onSubmit={handleCreate} />
          </div>
        )}

        {error ? (
          <div className="px-5 pb-5">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : schedules === null ? (
          <div className="px-5 pb-5 space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : schedules.length === 0 ? (
          <div className="border-t border-slate-100">
            <EmptyState
              icon={Clock}
              title="No work schedules yet"
              description="Add a schedule to mark late arrivals, early departures, and scheduled hours on Office Time."
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-100 border-t border-slate-100">
            {schedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                canEdit={canEdit}
                editing={editingId === s.id}
                onStartEdit={() => {
                  setEditingId(s.id);
                  setAdding(false);
                }}
                onCancelEdit={() => setEditingId(null)}
                onSave={(payload) => handleUpdate(s.id, payload)}
                onDelete={() => handleDelete(s)}
              />
            ))}
          </div>
        )}

        <div className="px-5 sm:px-6 py-3.5 border-t border-slate-100 bg-slate-50/40 rounded-b-2xl text-[12px] text-slate-500">
          Times are evaluated in the server&apos;s local timezone. Assign schedules to individual staff on the{' '}
          <Link href="/dashboard/employees" className="font-medium text-blue-600 hover:text-blue-700">
            Employees
          </Link>{' '}
          page.
        </div>
      </Card>
    </div>
  );
}
