'use client';

/**
 * Settings: everything an admin needs to set the system up from the browser (cameras, the camera account,
 * recognition, attendance and phone enrolment). Values are stored by the backend; the AI service picks up
 * changes within about 30 seconds, so nothing needs a restart.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Cctv, KeyRound, Loader2, ScanFace, Smartphone, UserCheck, X, type LucideIcon } from 'lucide-react';
import { Header } from '@/components/Header';
import { Card, Skeleton, btn } from '@/components/ui';
import { useShell } from '@/components/shell/ShellContext';
import { CamerasTab } from '@/components/settings/CamerasTab';
import { Notice, inputBase } from '@/components/settings/parts';
import { settingsApi, type SettingsSection, type SettingsSectionName } from '@/lib/api';
import { fmtTime } from '@/lib/format';

// ---------------------------------------------------------------- tabs

type TabId = 'cameras' | 'account' | 'recognition' | 'attendance' | 'enrollment';

const TABS: { id: TabId; label: string; icon: LucideIcon; description: string }[] = [
  { id: 'cameras', label: 'Cameras', icon: Cctv, description: 'Add cameras and choose which lenses recognise faces' },
  { id: 'account', label: 'EZVIZ account', icon: KeyRound, description: 'Only needed for EZVIZ cloud cameras' },
  { id: 'recognition', label: 'Recognition', icon: ScanFace, description: 'How sure the system must be before it names someone' },
  { id: 'attendance', label: 'Attendance', icon: UserCheck, description: 'Away time, check-out and repeat sightings' },
  { id: 'enrollment', label: 'Phone enrolment', icon: Smartphone, description: 'The QR code link and photos kept per employee' },
];

// ---------------------------------------------------------------- generic settings form

interface FieldDef {
  key: string;
  label: string;
  help?: string;
  unit?: string;
  type?: 'number' | 'text' | 'select';
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

interface FieldGroup {
  title: string;
  description?: string;
  fields: FieldDef[];
}

const RECOGNITION_GROUPS: FieldGroup[] = [
  {
    title: 'Matching',
    description: 'Scores run from 0 (different people) to 1 (the same photo).',
    fields: [
      {
        key: 'matchThreshold',
        label: 'Minimum match score',
        help: 'A face must score at least this against an enrolled photo. Higher means fewer wrong names, but more people missed.',
        step: 0.01,
        min: 0.3,
        max: 0.8,
      },
      {
        key: 'matchMargin',
        label: 'Lead over the next person',
        help: 'The best match must beat every other employee by this much, otherwise nobody is named.',
        step: 0.01,
        min: 0,
        max: 0.3,
      },
    ],
  },
  {
    title: 'Distant faces',
    description: 'Small faces carry less detail, so they must match more strongly.',
    fields: [
      { key: 'smallFaceEyePx', label: 'A face is distant below', unit: 'px between the eyes', help: '0 turns this rule off.', step: 1, min: 0, max: 200 },
      {
        key: 'smallFaceMatchThreshold',
        label: 'Minimum score for distant faces',
        help: 'Used instead of the normal minimum when it is higher.',
        step: 0.01,
        min: 0.3,
        max: 0.9,
      },
      { key: 'minFaceSize', label: 'Ignore faces smaller than', unit: 'px', help: 'Faces below this size are not looked at.', step: 1, min: 20, max: 300 },
    ],
  },
  {
    title: 'Confirming a sighting',
    description: 'One lucky frame is not enough to name someone.',
    fields: [
      { key: 'confirmFrames', label: 'Matches needed', unit: 'frames', step: 1, min: 1, max: 10 },
      { key: 'confirmWindowSec', label: 'Within', unit: 'seconds', step: 1, min: 2, max: 60 },
      {
        key: 'reportCooldownSec',
        label: 'Record the same person at most every',
        unit: 'seconds',
        help: 'Keeps one sighting a minute instead of one per frame.',
        step: 1,
        min: 10,
        max: 600,
      },
    ],
  },
  {
    title: 'Video',
    fields: [
      {
        key: 'frameSource',
        label: 'Video source',
        type: 'select',
        options: [
          { value: 'auto', label: 'Automatic: live video, snapshots as a backup' },
          { value: 'hls', label: 'Live video only' },
          { value: 'snapshot', label: 'Snapshots only (about every 4 seconds)' },
        ],
        help: 'Live video recognises people much sooner. Snapshots use less internet.',
      },
    ],
  },
];

const ATTENDANCE_GROUPS: FieldGroup[] = [
  {
    title: 'Time in the office',
    fields: [
      {
        key: 'awayAfterMin',
        label: 'Count someone as away after',
        unit: 'minutes not seen',
        help: 'Used by Office Time and Overview. Anyone viewing those pages can still pick another value there.',
        step: 1,
        min: 1,
        max: 120,
      },
      { key: 'sightingCreditMin', label: 'Time credited per stay', unit: 'minutes', help: "So a single sighting isn't counted as zero time.", step: 1, min: 0, max: 15 },
    ],
  },
  {
    title: 'Check-in and check-out',
    fields: [
      {
        key: 'autoCheckoutGapMin',
        label: 'Move check-out to the latest sighting after',
        unit: 'minutes',
        help: 'Sightings sooner than this after check-in leave the check-out time alone.',
        step: 1,
        min: 1,
        max: 240,
      },
      { key: 'recognitionDedupSec', label: 'Ignore repeat sightings within', unit: 'seconds', step: 1, min: 0, max: 600 },
    ],
  },
];

const ENROLLMENT_GROUPS: FieldGroup[] = [
  {
    title: 'Phone QR code',
    fields: [
      {
        key: 'mobileBaseUrl',
        label: 'Link address',
        type: 'text',
        placeholder: 'https://{lan_ip}:3443',
        help: '{lan_ip} is replaced with this computer’s current Wi-Fi address. Leave empty for a plain http link on the Wi-Fi.',
      },
      { key: 'mobileLinkTtlMin', label: 'A QR code works for', unit: 'minutes', step: 1, min: 5, max: 120 },
    ],
  },
  {
    title: 'Face photos',
    fields: [
      {
        key: 'maxFaceSamples',
        label: 'Photos kept per employee',
        unit: 'photos',
        help: 'When more are added, the oldest are removed.',
        step: 1,
        min: 3,
        max: 10,
      },
    ],
  },
];

function toDraft(values: Record<string, any>, groups: FieldGroup[]) {
  const out: Record<string, string> = {};
  for (const g of groups) for (const f of g.fields) out[f.key] = values[f.key] === null || values[f.key] === undefined ? '' : String(values[f.key]);
  return out;
}

function validate(f: FieldDef, raw: string): string | null {
  if ((f.type ?? 'number') !== 'number') return null;
  if (raw.trim() === '') return 'Enter a value';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'Enter a number';
  if (f.step === 1 && !Number.isInteger(n)) return 'Enter a whole number';
  if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return `Between ${f.min} and ${f.max}`;
  return null;
}

function SectionForm({
  name,
  groups,
  section,
  canEdit,
  onSaved,
  footnote,
}: {
  name: SettingsSectionName;
  groups: FieldGroup[];
  section: SettingsSection;
  canEdit: boolean;
  onSaved: (name: SettingsSectionName, s: SettingsSection, message: string) => void;
  footnote?: React.ReactNode;
}) {
  const fields = useMemo(() => groups.flatMap((g) => g.fields), [groups]);
  const [draft, setDraft] = useState(() => toDraft(section.values, groups));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(toDraft(section.values, groups)), [section, groups]);

  const errors = Object.fromEntries(fields.map((f) => [f.key, validate(f, draft[f.key] ?? '')]));
  const dirty = fields.filter((f) => (draft[f.key] ?? '') !== String(section.values[f.key] ?? ''));
  const hasErrors = fields.some((f) => errors[f.key]);
  const customised = section.customised.filter((k) => fields.some((f) => f.key === k));

  const submit = async (changes: Record<string, any>, message: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await settingsApi.save(name, changes);
      onSaved(name, res.data, message);
    } catch (e: any) {
      setError(e.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const save = () =>
    submit(
      Object.fromEntries(dirty.map((f) => [f.key, (f.type ?? 'number') === 'number' ? Number(draft[f.key]) : draft[f.key].trim()])),
      'Saved. The system uses the new settings within 30 seconds.'
    );
  const resetAll = () => submit(Object.fromEntries(fields.map((f) => [f.key, null])), 'Back to the default settings.');

  return (
    <Card>
      <div className="divide-y divide-slate-100">
        {groups.map((g) => (
          <div key={g.title} className="grid gap-x-8 gap-y-4 px-5 sm:px-6 py-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
            <div>
              <h3 className="text-[13.5px] font-semibold text-slate-900">{g.title}</h3>
              {g.description && <p className="mt-1 text-[12.5px] text-slate-500">{g.description}</p>}
            </div>
            <div className="space-y-4">
              {g.fields.map((f) => {
                const id = `${name}-${f.key}`;
                const err = errors[f.key];
                const def = section.defaults[f.key];
                const isDefault = String(def ?? '') === (draft[f.key] ?? '');
                const type = f.type ?? 'number';
                return (
                  <div key={f.key}>
                    <label htmlFor={id} className="block text-[13px] font-medium text-slate-700 mb-1.5">
                      {f.label}
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      {type === 'select' ? (
                        <select
                          id={id}
                          value={draft[f.key] ?? ''}
                          disabled={!canEdit || saving}
                          onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                          className={`${inputBase} w-full sm:w-auto pr-8`}
                        >
                          {f.options?.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={id}
                          type={type === 'number' ? 'number' : 'text'}
                          inputMode={type === 'number' ? 'decimal' : undefined}
                          step={f.step}
                          min={f.min}
                          max={f.max}
                          placeholder={f.placeholder}
                          value={draft[f.key] ?? ''}
                          disabled={!canEdit || saving}
                          aria-invalid={!!err}
                          aria-describedby={`${id}-help`}
                          onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                          className={`${inputBase} ${type === 'number' ? 'w-28 tabular-nums' : 'w-full max-w-md'} ${err ? 'ring-rose-300' : ''}`}
                        />
                      )}
                      {f.unit && <span className="text-[13px] text-slate-500">{f.unit}</span>}
                    </div>
                    <p id={`${id}-help`} className={`mt-1.5 text-[12px] ${err ? 'text-rose-600' : 'text-slate-500'}`}>
                      {err ?? (
                        <>
                          {f.help}
                          {!isDefault && def !== '' && def !== undefined && (
                            <span className="text-slate-400">
                              {f.help ? ' ' : ''}Default: {type === 'select' ? f.options?.find((o) => o.value === def)?.label ?? def : String(def)}
                              {f.unit && type === 'number' ? ` ${f.unit}` : ''}.
                            </span>
                          )}
                        </>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {(error || footnote) && (
        <div className="px-5 sm:px-6 pb-4 space-y-3">
          {error && <Notice tone="error">{error}</Notice>}
          {footnote}
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
          <button
            type="button"
            className={`${btn.ghost} disabled:text-slate-400 disabled:cursor-default`}
            disabled={saving || customised.length === 0}
            onClick={resetAll}
          >
            {customised.length ? 'Reset to defaults' : 'Using the defaults'}
          </button>
          <div className="flex items-center gap-2">
            {dirty.length > 0 && (
              <button type="button" className={btn.secondary} disabled={saving} onClick={() => setDraft(toDraft(section.values, groups))}>
                Discard
              </button>
            )}
            <button type="button" className={btn.primary} disabled={saving || dirty.length === 0 || hasErrors} onClick={save}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save changes
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- camera account

function AccountForm({
  section,
  canEdit,
  onSaved,
}: {
  section: SettingsSection;
  canEdit: boolean;
  onSaved: (name: SettingsSectionName, s: SettingsSection, message: string) => void;
}) {
  const v = section.values;
  const [appKey, setAppKey] = useState<string>(v.appKey ?? '');
  const [appSecret, setAppSecret] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(v.apiBaseUrl ?? '');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    setAppKey(section.values.appKey ?? '');
    setApiBaseUrl(section.values.apiBaseUrl ?? '');
    setAppSecret('');
  }, [section]);

  const secretSet = !!v.appSecretSet;
  const dirty = appKey.trim() !== (v.appKey ?? '') || apiBaseUrl.trim() !== (v.apiBaseUrl ?? '') || appSecret !== '';
  const missing = !appKey.trim() || (!secretSet && !appSecret);

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const res = await settingsApi.testEzviz({ appKey: appKey.trim(), appSecret: appSecret || undefined, apiBaseUrl: apiBaseUrl.trim() || undefined });
      setResult(res.data);
    } catch (e: any) {
      setResult({ ok: false, message: e.message || 'Test failed' });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setResult(null);
    try {
      const changes: Record<string, string> = { appKey: appKey.trim(), apiBaseUrl: apiBaseUrl.trim() };
      if (appSecret) changes.appSecret = appSecret;
      const res = await settingsApi.save('ezviz', changes);
      onSaved('ezviz', res.data, 'EZVIZ account saved.');
    } catch (e: any) {
      setResult({ ok: false, message: e.message || 'Could not save' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="grid gap-x-8 gap-y-4 px-5 sm:px-6 py-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div>
          <h3 className="text-[13.5px] font-semibold text-slate-900">EZVIZ account</h3>
          <p className="mt-1 text-[12.5px] text-slate-500">
            WorkSight reaches your cameras through the EZVIZ cloud. Find the App Key and App Secret on the EZVIZ Open Platform
            (open.ezvizlife.com) under My application.
          </p>
        </div>
        <div className="space-y-4">
          <div>
            <label htmlFor="ezviz-key" className="block text-[13px] font-medium text-slate-700 mb-1.5">
              App Key
            </label>
            <input
              id="ezviz-key"
              value={appKey}
              onChange={(e) => setAppKey(e.target.value)}
              disabled={!canEdit || !!busy}
              autoComplete="off"
              spellCheck={false}
              className={`${inputBase} w-full max-w-md font-mono`}
            />
          </div>
          <div>
            <label htmlFor="ezviz-secret" className="block text-[13px] font-medium text-slate-700 mb-1.5">
              App Secret
            </label>
            <input
              id="ezviz-secret"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              disabled={!canEdit || !!busy}
              autoComplete="new-password"
              placeholder={secretSet ? 'Saved. Type a new one to replace it' : ''}
              className={`${inputBase} w-full max-w-md font-mono placeholder:font-sans`}
            />
            <p className="mt-1.5 text-[12px] text-slate-500">Stored encrypted and never shown again.</p>
          </div>
          <details className="group">
            <summary className="cursor-pointer text-[12.5px] font-medium text-slate-600 hover:text-slate-900">Advanced</summary>
            <div className="mt-3">
              <label htmlFor="ezviz-url" className="block text-[13px] font-medium text-slate-700 mb-1.5">
                API address
              </label>
              <input
                id="ezviz-url"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                disabled={!canEdit || !!busy}
                spellCheck={false}
                className={`${inputBase} w-full max-w-md font-mono`}
              />
              <p className="mt-1.5 text-[12px] text-slate-500">Only change this if EZVIZ gave your account a regional address.</p>
            </div>
          </details>
          {result && (
            <Notice tone={result.ok ? 'success' : 'error'} onClose={() => setResult(null)}>
              {result.message}
            </Notice>
          )}
        </div>
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 sm:px-6 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
          <button type="button" className={btn.secondary} disabled={!!busy || missing} onClick={test}>
            {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" />}
            Test connection
          </button>
          <button type="button" className={btn.primary} disabled={!!busy || !dirty || !appKey.trim()} onClick={save}>
            {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- page

export default function SettingsPage() {
  const { status, refreshStatus } = useShell();
  const [tab, setTab] = useState<TabId>('cameras');
  const [data, setData] = useState<Record<SettingsSectionName, SettingsSection> | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && TABS.some((x) => x.id === t)) setTab(t as TabId);
  }, []);

  const selectTab = (t: TabId) => {
    setTab(t);
    window.history.replaceState(null, '', `?tab=${t}`);
  };

  // On phones the section list is a scrolling strip: keep the open section in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const strip = navRef.current;
    const el = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !el || strip.scrollWidth <= strip.clientWidth) return;
    const left = el.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft - 16;
    strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [tab]);

  const load = useCallback(async () => {
    try {
      const res = await settingsApi.all();
      setData(res.data);
      setCanEdit(res.canEdit);
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Could not load settings');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const notify = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const onSaved = (name: SettingsSectionName, s: SettingsSection, message: string) => {
    setData((d) => (d ? { ...d, [name]: s } : d));
    notify(message);
    window.setTimeout(refreshStatus, 31_000); // show the AI service's confirmation once it has picked them up
  };

  const current = TABS.find((t) => t.id === tab)!;
  const accountReady = !!data && !!data.ezviz.values.appKey && !!data.ezviz.values.appSecretSet;
  const applied =
    status?.reachable && status.settingsSource === 'dashboard' && status.settingsLoadedAt
      ? `The AI service last loaded these at ${fmtTime(status.settingsLoadedAt, true)}.`
      : status && !status.reachable
      ? 'The AI service is not running, so it will use these when it starts.'
      : null;

  return (
    <>
      <Header title="Settings" subtitle="Set up cameras and how the system works. Changes apply within 30 seconds, without a restart." />

      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-[1440px] w-full mx-auto">
        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <nav ref={navRef} aria-label="Settings sections" className="-mx-4 px-4 overflow-x-auto lg:mx-0 lg:px-0 lg:overflow-visible">
            <ul className="flex gap-1 lg:flex-col">
              {TABS.map((t) => {
                const active = t.id === tab;
                const Icon = t.icon;
                return (
                  <li key={t.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => selectTab(t.id)}
                      aria-current={active ? 'page' : undefined}
                      className={`flex w-full items-center gap-2.5 h-9 px-3 rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors ${
                        active ? 'bg-white text-slate-900 ring-1 ring-slate-200 shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                      }`}
                    >
                      <Icon className={`w-4 h-4 ${active ? 'text-slate-900' : 'text-slate-400'}`} />
                      {t.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 space-y-4">
            <div>
              <h2 className="text-[16px] font-semibold text-slate-900">{current.label}</h2>
              <p className="text-[13px] text-slate-500 mt-0.5">{current.description}</p>
            </div>

            {data && !canEdit && <Notice tone="info">Only admins can change settings. You can look at them here.</Notice>}
            {error && <Notice tone="error">{error}</Notice>}

            {!data && !error ? (
              <Card className="p-6 space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-9 w-72" />
                <Skeleton className="h-9 w-56" />
              </Card>
            ) : data ? (
              <>
                {tab === 'cameras' && (
                  <CamerasTab canEdit={canEdit} accountReady={accountReady} status={status} notify={notify} goToAccount={() => selectTab('account')} />
                )}
                {tab === 'account' && <AccountForm section={data.ezviz} canEdit={canEdit} onSaved={onSaved} />}
                {tab === 'recognition' && (
                  <SectionForm
                    name="recognition"
                    groups={RECOGNITION_GROUPS}
                    section={data.recognition}
                    canEdit={canEdit}
                    onSaved={onSaved}
                    footnote={applied && <p className="text-[12px] text-slate-500">{applied}</p>}
                  />
                )}
                {tab === 'attendance' && <SectionForm name="attendance" groups={ATTENDANCE_GROUPS} section={data.attendance} canEdit={canEdit} onSaved={onSaved} />}
                {tab === 'enrollment' && <SectionForm name="enrollment" groups={ENROLLMENT_GROUPS} section={data.enrollment} canEdit={canEdit} onSaved={onSaved} />}
              </>
            ) : null}
          </div>
        </div>
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
    </>
  );
}
