'use client';

/**
 * Settings > Integrations: API keys that other systems (an ERP) use to call /api/v1, and webhooks WorkSight sends
 * live events to. A key or webhook secret is shown once, when it is made. Needs users.manage.
 */

import React, { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Copy, ExternalLink, KeyRound, Loader2, Plus, Webhook, X } from 'lucide-react';
import { Card, EmptyState, Skeleton, btn } from '@/components/ui';
import { Notice, StatusText, inputBase } from '@/components/settings/parts';
import { integrationsApi, type ApiKeyInfo, type WebhookDeliveryInfo, type WebhookInfo } from '@/lib/api';
import { fmtTime, timeAgo } from '@/lib/format';

type Notify = (message: string, type?: 'success' | 'error') => void;

const SCOPE_INFO: Record<string, { label: string; help: string }> = {
  'employees:read': { label: 'See employees', help: 'Employees, departments and work schedules' },
  'employees:write': { label: 'Change employees', help: 'Add and update employees, send face-enrolment links' },
  'attendance:read': { label: 'See attendance', help: 'Attendance, timesheets, who is in now, and live updates (webhooks)' },
  'attendance:write': { label: 'Record check-ins', help: 'Manual check-ins and check-outs, e.g. for staff working off-site' },
};
const EVENT_LABEL: Record<string, string> = {
  'employee.arrived': 'Arrived',
  'employee.went_away': 'Went away',
  'employee.came_back': 'Came back',
  'webhook.test': 'Test',
};
const DEFAULT_SCOPES = ['employees:read', 'attendance:read'];

const small =
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg bg-white text-[12.5px] font-medium ring-1 ring-inset shadow-sm transition-colors disabled:opacity-50';
const smallNeutral = `${small} text-slate-700 ring-slate-200 hover:bg-slate-50`;
const smallDanger = `${small} text-rose-700 ring-rose-200 hover:bg-rose-50`;
const chip = 'inline-flex items-center h-[22px] px-2 rounded-md text-[12px]';

function apiAddress() {
  if (typeof window === 'undefined') return { url: '/api/v1', secure: true };
  return { url: `${window.location.origin}/api/v1`, secure: window.location.protocol === 'https:' };
}

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = 'Copy', primary = false }: { text: string; label?: string; primary?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={primary ? btn.primary : btn.secondary}
      onClick={async () => {
        setState((await copyText(text)) ? 'copied' : 'failed');
        window.setTimeout(() => setState('idle'), 2500);
      }}
    >
      {state === 'copied' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy it' : label}
    </button>
  );
}

// ---------------------------------------------------------------- dialogs

function Dialog({
  title,
  description,
  icon,
  onClose,
  dismissable = true,
  footer,
  children,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  onClose: () => void;
  dismissable?: boolean; // false for "shown once" dialogs: a stray click mustn't lose the key
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissable, onClose]);
  // Rendered into <body>: inside the page, a parent's spacing (space-y-*) would push the full-screen overlay down.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onMouseDown={dismissable ? onClose : undefined}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {icon}
            <div className="min-w-0">
              <h2 id={titleId} className="text-[16px] font-semibold text-slate-900">
                {title}
              </h2>
              {description && <p className="text-[12.5px] text-slate-500 mt-0.5">{description}</p>}
            </div>
          </div>
          {dismissable && (
            <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function NewKeyDialog({ scopes, onClose, onCreated }: { scopes: string[]; onClose: () => void; onCreated: (k: ApiKeyInfo & { key: string }) => void }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>(DEFAULT_SCOPES.filter((s) => scopes.includes(s)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onCreated((await integrationsApi.createKey(name.trim(), picked)).data);
    } catch (err: any) {
      setError(err.message || 'Could not make the key');
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="New key"
      description="For one system. It signs in with this key instead of a password."
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-key-form" className={btn.primary} disabled={saving || !name.trim() || picked.length === 0}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Create key
          </button>
        </>
      }
    >
      <form id="new-key-form" onSubmit={submit} className="space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        <div className="space-y-1.5">
          <label htmlFor="key-name" className="block text-[13px] font-medium text-slate-900">
            Which system is it for?
          </label>
          <input id="key-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. ERPNext" className={`${inputBase} w-full`} />
          <p className="text-[12px] text-slate-500">Shown in the key list and the audit log.</p>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-[13px] font-medium text-slate-900 mb-2">What may it do?</legend>
          {scopes.map((s) => {
            const info = SCOPE_INFO[s] ?? { label: s, help: '' };
            const on = picked.includes(s);
            return (
              <label key={s} className={`flex gap-2.5 items-start rounded-xl px-3 py-2.5 ring-1 ring-inset cursor-pointer ${on ? 'ring-slate-300 bg-slate-50' : 'ring-slate-200'}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setPicked((p) => (on ? p.filter((x) => x !== s) : [...p, s]))}
                  className="mt-0.5 w-4 h-4 accent-slate-900"
                />
                <span>
                  <span className="block text-[13px] font-medium text-slate-900">{info.label}</span>
                  <span className="block text-[12px] text-slate-500">{info.help}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="text-[12px] text-slate-500">Tick only what this system needs. Face photos and camera video are never available to it.</p>
      </form>
    </Dialog>
  );
}

function ShownOnceDialog({
  title,
  label,
  value,
  lostHint,
  onDone,
  children,
}: {
  title: string;
  label: string;
  value: string;
  lostHint: string;
  onDone: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog
      title={title}
      onClose={onDone}
      dismissable={false}
      icon={
        <span className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
          <Check className="w-4 h-4" />
        </span>
      }
      footer={
        <button type="button" className={btn.secondary} onClick={onDone}>
          I&apos;ve saved it
        </button>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 items-start rounded-xl px-3 py-2.5 bg-amber-50 ring-1 ring-inset ring-amber-200 text-[13px] text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Copy it now. WorkSight shows it only this once. {lostHint}</span>
        </div>
        <div className="space-y-1.5">
          <span className="block text-[12px] text-slate-500">{label}</span>
          <div className="flex gap-2 items-stretch">
            <code className="flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-slate-50 ring-1 ring-inset ring-slate-200 font-mono text-[12.5px] text-slate-900 break-all select-all">
              {value}
            </code>
            <CopyButton text={value} primary />
          </div>
        </div>
        {children}
      </div>
    </Dialog>
  );
}

function NewWebhookDialog({ events, onClose, onCreated }: { events: string[]; onClose: () => void; onCreated: (w: WebhookInfo & { secret: string }) => void }) {
  const [url, setUrl] = useState('');
  const [picked, setPicked] = useState<string[]>(events);
  const [away, setAway] = useState('15');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const awayMin = Number(away);
  const awayOk = Number.isInteger(awayMin) && awayMin >= 1 && awayMin <= 120;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await integrationsApi.createWebhook({ url: url.trim(), events: picked, awayAfterMin: awayMin, description: description.trim() || undefined });
      onCreated(res.data);
    } catch (err: any) {
      setError(err.message || 'Could not add the webhook');
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Add webhook"
      description="WorkSight sends a signed message to this address the moment something happens."
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-webhook-form" className={btn.primary} disabled={saving || !url.trim() || picked.length === 0 || !awayOk}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Add webhook
          </button>
        </>
      }
    >
      <form id="new-webhook-form" onSubmit={submit} className="space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        <div className="space-y-1.5">
          <label htmlFor="hook-url" className="block text-[13px] font-medium text-slate-900">
            Address
          </label>
          <input
            id="hook-url"
            type="url"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://erp.example.com/api/method/worksight.receive"
            className={`${inputBase} w-full font-mono text-[12.5px]`}
          />
          <p className="text-[12px] text-slate-500">Your ERP developers give you this. Use https://. Plain http:// only works for an address on your office network.</p>
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-slate-900 mb-2">Send these events</legend>
          <div className="flex flex-wrap gap-2">
            {events.map((ev) => {
              const on = picked.includes(ev);
              return (
                <label key={ev} className={`inline-flex items-center gap-2 h-9 px-3 rounded-lg ring-1 ring-inset cursor-pointer text-[13px] ${on ? 'ring-slate-300 bg-slate-50 text-slate-900' : 'ring-slate-200 text-slate-600'}`}>
                  <input type="checkbox" checked={on} onChange={() => setPicked((p) => (on ? p.filter((x) => x !== ev) : [...p, ev]))} className="w-4 h-4 accent-slate-900" />
                  {EVENT_LABEL[ev] ?? ev}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <label htmlFor="hook-away" className="block text-[13px] font-medium text-slate-900">
            Count someone as away after
          </label>
          <div className="flex items-center gap-2">
            <input id="hook-away" type="number" min={1} max={120} value={away} onChange={(e) => setAway(e.target.value)} className={`${inputBase} w-24 tabular-nums ${awayOk ? '' : 'ring-rose-300'}`} />
            <span className="text-[13px] text-slate-600">minutes unseen</span>
          </div>
          <p className="text-[12px] text-slate-500">Shorter gaps, like a quick coffee, don&apos;t send &quot;Went away&quot;. 1 to 120 minutes.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="hook-desc" className="block text-[13px] font-medium text-slate-900">
            Note <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input id="hook-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="e.g. ERPNext live attendance" className={`${inputBase} w-full`} />
        </div>
      </form>
    </Dialog>
  );
}

function deliveryResult(d: WebhookDeliveryInfo): { tone: 'emerald' | 'amber' | 'rose' | 'slate'; text: string } {
  if (d.status === 'DELIVERED') return { tone: 'emerald', text: d.attempts > 1 ? `Delivered on try ${d.attempts}` : 'Delivered' };
  if (d.status === 'FAILED') return { tone: 'rose', text: `Failed: ${d.lastError ?? 'no answer'}` };
  if (d.status === 'SENDING') return { tone: 'slate', text: 'Sending…' };
  return { tone: 'amber', text: `${d.lastError ? `${d.lastError}. ` : ''}Trying again at ${fmtTime(d.nextAttemptAt)}` };
}

function DeliveriesDialog({ hook, onClose }: { hook: WebhookInfo; onClose: () => void }) {
  const [rows, setRows] = useState<WebhookDeliveryInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    integrationsApi
      .deliveries(hook.id)
      .then((r) => setRows(r.data))
      .catch((e) => setError(e.message || 'Could not load deliveries'));
  }, [hook.id]);

  return (
    <Dialog title="Deliveries" description={hook.url} onClose={onClose}>
      {error && <Notice tone="error">{error}</Notice>}
      {!rows && !error && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
      {rows && rows.length === 0 && <p className="text-[13px] text-slate-500">Nothing sent yet. Events go out as people arrive and leave.</p>}
      {rows && rows.length > 0 && (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[460px] text-[13px]">
            <thead>
              <tr className="text-left text-[12px] text-slate-500 bg-slate-50">
                <th className="px-5 py-2 font-medium">Time</th>
                <th className="px-2 py-2 font-medium">Event</th>
                <th className="px-5 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const r = deliveryResult(d);
                const who = typeof d.data?.employeeCode === 'string' ? ` · ${d.data.employeeCode}` : '';
                return (
                  <tr key={d.id} className="border-t border-slate-100">
                    <td className="px-5 py-2.5 text-slate-500 tabular-nums whitespace-nowrap">{timeAgo(d.createdAt)}</td>
                    <td className="px-2 py-2.5 whitespace-nowrap">
                      {EVENT_LABEL[d.event] ?? d.event}
                      {who}
                    </td>
                    <td className="px-5 py-2.5 max-w-[16rem]">
                      <StatusText tone={r.tone}>{r.text}</StatusText>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[12px] text-slate-500">Kept for 30 days.</p>
    </Dialog>
  );
}

function ConfirmDialog({ title, body, confirm, onCancel, onConfirm }: { title: string; body: string; confirm: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [working, setWorking] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className={btn.secondary} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              await onConfirm();
            }}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-rose-600 text-white text-[13px] font-medium shadow-sm hover:bg-rose-700 transition-colors disabled:opacity-50"
          >
            {working && <Loader2 className="w-4 h-4 animate-spin" />}
            {confirm}
          </button>
        </>
      }
    >
      <p className="text-[13px] text-slate-700">{body}</p>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the tab

type DialogState =
  | null
  | { kind: 'newKey' }
  | { kind: 'keyShown'; name: string; key: string }
  | { kind: 'revokeKey'; key: ApiKeyInfo }
  | { kind: 'newWebhook' }
  | { kind: 'secretShown'; secret: string }
  | { kind: 'deliveries'; hook: WebhookInfo }
  | { kind: 'removeWebhook'; hook: WebhookInfo };

function webhookStatus(h: WebhookInfo) {
  if (!h.isActive) return <StatusText tone="slate">Stopped: the API key it was made with was revoked</StatusText>;
  if (h.lastStatus === 'FAILING') return <StatusText tone="rose">{`Failing: ${h.lastError ?? 'no answer'}`}</StatusText>;
  if (h.lastStatus === 'OK') return <StatusText tone="emerald">{`Working. Last delivered ${timeAgo(h.lastDeliveryAt)}.`}</StatusText>;
  return <StatusText tone="slate">Nothing sent yet. Events go out as people arrive and leave.</StatusText>;
}

export function IntegrationsTab({ notify }: { notify: Notify }) {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [hooks, setHooks] = useState<WebhookInfo[] | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [address, setAddress] = useState({ url: '/api/v1', secure: true });

  const load = useCallback(async () => {
    try {
      const [k, w] = await Promise.all([integrationsApi.keys(), integrationsApi.webhooks()]);
      setKeys(k.data);
      setScopes(k.scopes.map((s) => s.scope));
      setHooks(w.data);
      setEvents(w.events.map((e) => e.event));
      setError(null);
    } catch (e: any) {
      setError(e.message || 'Could not load integrations');
    }
  }, []);

  useEffect(() => {
    setAddress(apiAddress());
    load();
  }, [load]);

  const close = useCallback(() => setDialog(null), []);

  const test = async (h: WebhookInfo) => {
    setTesting(h.id);
    try {
      const d = (await integrationsApi.testWebhook(h.id)).data;
      if (d.status === 'DELIVERED') notify(`Test delivered: answered ${d.lastStatusCode}.`);
      else notify(`Test failed: ${d.lastError ?? 'no answer'}`, 'error');
      await load();
    } catch (e: any) {
      notify(e.message || 'Could not send the test', 'error');
    } finally {
      setTesting(null);
    }
  };

  if (error && !keys) return <Notice tone="error">{error}</Notice>;
  if (!keys || !hooks) {
    return (
      <Card className="p-6 space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-56" />
      </Card>
    );
  }

  const docs = `${address.url}/docs`;

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}

      <Card className="px-4 sm:px-5 py-4 flex flex-wrap gap-3 items-center justify-between">
        <div className="min-w-0">
          <div className="text-[12px] text-slate-500">API address for developers</div>
          <div className="mt-0.5 font-mono text-[13px] text-slate-900 break-all">{address.url}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={address.url} label="Copy address" />
          <a href={docs} target="_blank" rel="noopener noreferrer" className={btn.secondary}>
            Developer docs
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
        {!address.secure && (
          <div className="basis-full">
            <Notice tone="info">This page is open over plain HTTP. Give developers your https:// address: the API refuses plain HTTP.</Notice>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 sm:px-5 py-4 flex flex-wrap gap-3 items-center justify-between border-b border-slate-100">
          <div>
            <h3 className="text-[14px] font-semibold text-slate-900">API keys</h3>
            <p className="text-[12.5px] text-slate-500 mt-0.5">Each system gets its own key. Revoke a key to cut that system off at once.</p>
          </div>
          <button type="button" className={btn.primary} onClick={() => setDialog({ kind: 'newKey' })}>
            <Plus className="w-4 h-4" />
            New key
          </button>
        </div>
        {keys.length === 0 ? (
          <EmptyState icon={KeyRound} title="No keys yet" description="Make one for each system that should connect, such as your ERP." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="bg-slate-50 text-left text-[12px] text-slate-500">
                  <th className="px-5 py-2.5 font-medium">System</th>
                  <th className="px-3 py-2.5 font-medium">Key</th>
                  <th className="px-3 py-2.5 font-medium">Allowed to</th>
                  <th className="px-3 py-2.5 font-medium">Last used</th>
                  <th className="px-5 py-2.5 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) =>
                  k.isActive ? (
                    <tr key={k.id} className="border-t border-slate-100 align-top">
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-slate-900">{k.name}</div>
                        <div className="mt-0.5 text-[12px] text-slate-500">
                          Made {fmtDay(k.createdAt)}
                          {k.createdByName ? ` by ${k.createdByName}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-3.5 font-mono text-[12.5px] text-slate-700 whitespace-nowrap">{k.keyPrefix}…</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1 max-w-[300px]">
                          {k.scopes.map((s) => (
                            <span key={s} className={`${chip} bg-slate-100 text-slate-700`}>
                              {SCOPE_INFO[s]?.label ?? s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap">
                        {k.lastUsedAt ? <StatusText tone="emerald">{timeAgo(k.lastUsedAt)}</StatusText> : <span className="text-[12.5px] text-slate-500">Never</span>}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <button type="button" className={smallDanger} onClick={() => setDialog({ kind: 'revokeKey', key: k })}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={k.id} className="border-t border-slate-100 align-top text-slate-500">
                      <td className="px-5 py-3.5">
                        <div className="font-medium">{k.name}</div>
                        <div className="mt-0.5 text-[12px]">Revoked {k.revokedAt ? fmtDay(k.revokedAt) : ''}</div>
                      </td>
                      <td className="px-3 py-3.5 font-mono text-[12.5px] whitespace-nowrap line-through">{k.keyPrefix}…</td>
                      <td className="px-3 py-3.5 text-[12.5px]">{k.scopes.map((s) => SCOPE_INFO[s]?.label ?? s).join(', ')}</td>
                      <td className="px-3 py-3.5 text-[12.5px] whitespace-nowrap">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'Never'}</td>
                      <td className="px-5 py-3.5" />
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 sm:px-5 py-4 flex flex-wrap gap-3 items-center justify-between border-b border-slate-100">
          <div>
            <h3 className="text-[14px] font-semibold text-slate-900">Webhooks</h3>
            <p className="text-[12.5px] text-slate-500 mt-0.5">WorkSight tells these addresses the moment someone arrives, steps away or comes back.</p>
          </div>
          <button type="button" className={btn.secondary} onClick={() => setDialog({ kind: 'newWebhook' })}>
            <Plus className="w-4 h-4" />
            Add webhook
          </button>
        </div>
        {hooks.length === 0 ? (
          <EmptyState icon={Webhook} title="No webhooks yet" description="Add one to send arrivals and departures to your ERP as they happen. Developers can also add their own with their key." />
        ) : (
          <ul>
            {hooks.map((h, i) => (
              <li key={h.id} className={`px-4 sm:px-5 py-4 flex flex-wrap gap-4 items-start justify-between ${i ? 'border-t border-slate-100' : ''}`}>
                <div className="min-w-0 flex-[1_1_360px] space-y-2">
                  <div className="font-mono text-[13px] text-slate-900 break-all">{h.url}</div>
                  <div className="flex flex-wrap gap-1 items-center">
                    {h.events.map((ev) => (
                      <span key={ev} className={`${chip} bg-blue-50 text-blue-700`}>
                        {EVENT_LABEL[ev] ?? ev}
                      </span>
                    ))}
                    <span className="ml-1.5 text-[12px] text-slate-500">Away = unseen for {h.awayAfterMin} min</span>
                  </div>
                  <div className="text-[12px] text-slate-500">
                    {h.createdBy === 'api' ? `Added by ${h.apiKeyName ?? 'a system'} with its key` : `Added ${fmtDay(h.createdAt)}`}
                    {h.description ? ` · ${h.description}` : ''}
                  </div>
                  <div className="max-w-full">{webhookStatus(h)}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={smallNeutral} disabled={testing === h.id || !h.isActive} onClick={() => test(h)}>
                    {testing === h.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Send test
                  </button>
                  <button type="button" className={smallNeutral} onClick={() => setDialog({ kind: 'deliveries', hook: h })}>
                    Deliveries
                  </button>
                  <button type="button" className={smallDanger} onClick={() => setDialog({ kind: 'removeWebhook', hook: h })}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="px-4 sm:px-5 py-3 border-t border-slate-100 bg-slate-50 text-[12px] text-slate-500">
          Every delivery is signed, so your ERP can check it really came from WorkSight. Failed deliveries are retried for about a day.
        </p>
      </Card>

      {dialog?.kind === 'newKey' && (
        <NewKeyDialog
          scopes={scopes}
          onClose={close}
          onCreated={(k) => {
            setDialog({ kind: 'keyShown', name: k.name, key: k.key });
            load();
          }}
        />
      )}
      {dialog?.kind === 'keyShown' && (
        <ShownOnceDialog title={`Key made for ${dialog.name}`} label="API key" value={dialog.key} lostHint="If it gets lost, revoke it and make a new one." onDone={close}>
          <div className="rounded-xl ring-1 ring-inset ring-slate-200 p-3 space-y-1.5 text-[12.5px] text-slate-600">
            <p className="text-[13px] font-medium text-slate-900">For the {dialog.name} developers</p>
            <p>
              API address: <span className="font-mono text-slate-900 break-all">{address.url}</span>
            </p>
            <p>
              How to use it:{' '}
              <a href={docs} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:text-blue-700">
                Developer docs
              </a>
            </p>
            <p className="text-[12px] text-slate-500">Send the key separately, for example by phone or a password manager, not in the same email.</p>
          </div>
        </ShownOnceDialog>
      )}
      {dialog?.kind === 'revokeKey' && (
        <ConfirmDialog
          title={`Revoke the ${dialog.key.name} key?`}
          body={`${dialog.key.name} stops working with WorkSight at once, along with any webhooks it added itself. This can't be undone: to reconnect, make a new key.`}
          confirm="Revoke key"
          onCancel={close}
          onConfirm={async () => {
            try {
              await integrationsApi.revokeKey(dialog.key.id);
              notify(`Revoked. ${dialog.key.name} can no longer use this key.`);
            } catch (e: any) {
              notify(e.message || 'Could not revoke the key', 'error');
            }
            close();
            load();
          }}
        />
      )}
      {dialog?.kind === 'newWebhook' && (
        <NewWebhookDialog
          events={events}
          onClose={close}
          onCreated={(w) => {
            setDialog({ kind: 'secretShown', secret: w.secret });
            load();
          }}
        />
      )}
      {dialog?.kind === 'secretShown' && (
        <ShownOnceDialog
          title="Webhook added"
          label="Signing secret"
          value={dialog.secret}
          lostHint="If it gets lost, remove the webhook and add it again."
          onDone={close}
        >
          <p className="text-[12.5px] text-slate-600">
            Give this to the ERP developers. Their system uses it to check that each message really came from WorkSight (the{' '}
            <span className="font-mono">X-WorkSight-Signature</span> header). The{' '}
            <a href={docs} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:text-blue-700">
              developer docs
            </a>{' '}
            show how.
          </p>
        </ShownOnceDialog>
      )}
      {dialog?.kind === 'deliveries' && <DeliveriesDialog hook={dialog.hook} onClose={close} />}
      {dialog?.kind === 'removeWebhook' && (
        <ConfirmDialog
          title="Remove this webhook?"
          body={`Nothing more will be sent to ${dialog.hook.url}.`}
          confirm="Remove webhook"
          onCancel={close}
          onConfirm={async () => {
            try {
              await integrationsApi.removeWebhook(dialog.hook.id);
              notify('Webhook removed.');
            } catch (e: any) {
              notify(e.message || 'Could not remove the webhook', 'error');
            }
            close();
            load();
          }}
        />
      )}
    </div>
  );
}
