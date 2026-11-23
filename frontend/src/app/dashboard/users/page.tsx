'use client';

/**
 * Users & access: who can sign in, and what each person can see and change.
 * Only admins reach this page; the server enforces every rule (no self-lockout, Super admins protected,
 * Employee logins tied to one employee record).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Lock, Minus, Pencil, Plus, ShieldCheck, Trash2, UserPlus, X } from 'lucide-react';
import { Header } from '@/components/Header';
import { Avatar, Card, CardHeader, EmptyState, Skeleton, Tag, btn } from '@/components/ui';
import { Field, Notice, inputBase } from '@/components/settings/parts';
import { api, usersApi, type AccountActivity, type Permission, type RoleInfo, type UserAccount } from '@/lib/api';
import { timeAgo } from '@/lib/format';

const PERM_COLUMNS: { perm: Permission; label: string }[] = [
  { perm: 'self.view', label: 'Own time' },
  { perm: 'reports.view', label: 'All reports' },
  { perm: 'cameras.live', label: 'Live cameras' },
  { perm: 'people.manage', label: 'Employees & corrections' },
  { perm: 'setup.manage', label: 'Cameras & settings' },
  { perm: 'users.manage', label: 'Users' },
];

type Emp = { id: string; fullName: string; employeeCode: string; isActive?: boolean };

function statusOf(u: UserAccount): { tone: 'emerald' | 'amber' | 'rose' | 'slate'; text: string } {
  if (!u.isActive) return { tone: 'slate', text: 'Disabled' };
  if (u.isLocked) return { tone: 'rose', text: 'Locked' };
  if (u.mustChangePassword) return { tone: 'amber', text: 'Waiting for first sign-in' };
  return { tone: 'emerald', text: 'Active' };
}

function Dot({ tone }: { tone: 'emerald' | 'amber' | 'rose' | 'slate' }) {
  const c = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', slate: 'bg-slate-300' }[tone];
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c}`} aria-hidden="true" />;
}

// ---------------------------------------------------------------- dialog shell

function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" className="fixed inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={panel} className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} bg-white rounded-2xl shadow-xl ring-1 ring-slate-200 my-8`}>
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 pt-5">
          <h2 className="text-[16px] font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TemporaryPassword({ name, email, password, onDone }: { name: string; email: string; password: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the password stays visible to copy by hand */
    }
  };
  return (
    <div className="px-5 sm:px-6 py-5 space-y-4">
      <p className="text-[13.5px] text-slate-700">
        Give these to <span className="font-medium">{name}</span>. They&apos;ll choose their own password the first time they sign in.
      </p>
      <dl className="rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200 p-4 space-y-3">
        <div>
          <dt className="text-[12px] text-slate-500">Email</dt>
          <dd className="text-[14px] font-medium text-slate-900 break-all">{email}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-slate-500">Temporary password</dt>
          <dd className="flex items-center gap-2">
            <span className="text-[18px] font-mono font-semibold tracking-wider text-slate-900 select-all">{password}</span>
            <button type="button" className={btn.secondary} onClick={copy}>
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </dd>
        </div>
      </dl>
      <p className="text-[12.5px] text-slate-500">This password is shown only now. If it gets lost, reset it again.</p>
      <div className="flex justify-end">
        <button type="button" className={btn.primary} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- add / edit

function RolePicker({ roles, value, onChange, disabled }: { roles: RoleInfo[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled}>
      <legend className="block text-[13px] font-medium text-slate-700 mb-1.5">Access level</legend>
      <div className="space-y-2">
        {roles.map((r) => (
          <label
            key={r.value}
            className={`flex items-start gap-3 rounded-xl px-3.5 py-2.5 ring-1 ring-inset transition cursor-pointer ${
              value === r.value ? 'ring-2 ring-blue-600 bg-blue-50/40' : 'ring-slate-200 hover:ring-slate-300'
            } ${!r.assignable ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <input
              type="radio"
              name="role"
              value={r.value}
              checked={value === r.value}
              disabled={!r.assignable || disabled}
              onChange={() => onChange(r.value)}
              className="mt-1 accent-blue-600"
            />
            <span>
              <span className="block text-[13.5px] font-medium text-slate-900">{r.label}</span>
              <span className="block text-[12.5px] text-slate-500">{r.assignable ? r.description : 'Only a Super admin can give this access.'}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function UserDialog({
  user,
  roles,
  employees,
  linked,
  onClose,
  onSaved,
  onDeleted,
}: {
  user: UserAccount | null; // null = new
  roles: RoleInfo[];
  employees: Emp[];
  linked: Map<string, string>; // employeeId -> user name (other logins)
  onClose: () => void;
  onSaved: (u: UserAccount, message: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [name, setName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState(user?.role ?? '');
  const [employeeId, setEmployeeId] = useState(user?.employee?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ password: string; account: UserAccount } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const needsEmployee = role === 'EMPLOYEE';
  const valid = name.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && role && (!needsEmployee || employeeId);
  const readOnly = !!user && !user.canEdit;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message || 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      const body = { fullName: name.trim(), email: email.trim(), role, employeeId: employeeId || null };
      if (!user) {
        const res = await usersApi.create(body);
        setTemp({ password: res.temporaryPassword, account: res.data });
      } else {
        const res = await usersApi.update(user.id, body);
        onSaved(res.data, `${res.data.fullName} updated.`);
      }
    });

  if (temp) {
    return (
      <Dialog title={user ? 'Password reset' : 'User created'} onClose={() => onSaved(temp.account, user ? 'Password reset.' : `${temp.account.fullName} can now sign in.`)}>
        <TemporaryPassword
          name={temp.account.fullName}
          email={temp.account.email}
          password={temp.password}
          onDone={() => onSaved(temp.account, user ? 'Password reset.' : `${temp.account.fullName} can now sign in.`)}
        />
      </Dialog>
    );
  }

  return (
    <Dialog title={user ? `Edit ${user.fullName}` : 'Add a user'} onClose={onClose} wide>
      <div className="px-5 sm:px-6 py-5 space-y-5">
        {readOnly && <Notice tone="info">Only a Super admin can change a Super admin&apos;s account.</Notice>}
        {user?.isYou && <Notice tone="info">This is your own account. You can&apos;t change your own access level or disable yourself.</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="u-name" label="Full name">
            <input id="u-name" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly || !!busy} className={`${inputBase} w-full`} />
          </Field>
          <Field id="u-email" label="Email (used to sign in)">
            <input
              id="u-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={readOnly || !!busy}
              autoComplete="off"
              spellCheck={false}
              className={`${inputBase} w-full`}
            />
          </Field>
        </div>
        <RolePicker roles={roles} value={role} onChange={setRole} disabled={readOnly || !!busy || !!user?.isYou} />
        <Field
          id="u-emp"
          label={needsEmployee ? 'Which employee is this?' : 'Linked employee'}
          optional={!needsEmployee}
          help={needsEmployee ? 'They will see only this employee’s office time and attendance.' : 'Links the login to an employee record, so they also get “My time”.'}
        >
          <select id="u-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={readOnly || !!busy} className={`${inputBase} w-full sm:w-96 pr-8`}>
            <option value="">{needsEmployee ? 'Choose an employee…' : 'Not linked'}</option>
            {employees.map((emp) => {
              const other = linked.get(emp.id);
              const taken = !!other && emp.id !== user?.employee?.id;
              return (
                <option key={emp.id} value={emp.id} disabled={taken}>
                  {emp.fullName} ({emp.employeeCode}){taken ? ` — login: ${other}` : ''}
                </option>
              );
            })}
          </select>
        </Field>
        {!user && (
          <p className="text-[12.5px] text-slate-500">
            A temporary password is created for you to hand over. They must choose their own the first time they sign in.
          </p>
        )}
        {error && <Notice tone="error">{error}</Notice>}

        {user && !readOnly && !user.isYou && (
          <div className="rounded-xl ring-1 ring-inset ring-slate-200 divide-y divide-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-[13px] font-medium text-slate-800">Password</p>
                <p className="text-[12.5px] text-slate-500">Creates a new temporary password and signs them out everywhere.</p>
              </div>
              <button
                type="button"
                className={btn.secondary}
                disabled={!!busy}
                onClick={() =>
                  run('reset', async () => {
                    const res = await usersApi.resetPassword(user.id);
                    setTemp({ password: res.temporaryPassword, account: res.data });
                  })
                }
              >
                {busy === 'reset' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                Reset password
              </button>
            </div>
            {user.isLocked && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-[13px] font-medium text-slate-800">Locked</p>
                  <p className="text-[12.5px] text-slate-500">Too many wrong passwords. It unlocks by itself after 15 minutes.</p>
                </div>
                <button
                  type="button"
                  className={btn.secondary}
                  disabled={!!busy}
                  onClick={() => run('unlock', async () => onSaved((await usersApi.update(user.id, { unlock: true })).data, `${user.fullName} unlocked.`))}
                >
                  <Lock className="w-4 h-4" /> Unlock now
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-[13px] font-medium text-slate-800">{user.isActive ? 'Disable account' : 'Account is disabled'}</p>
                <p className="text-[12.5px] text-slate-500">
                  {user.isActive ? 'They are signed out at once and can’t sign in. Nothing is deleted.' : 'Turn it back on to let them sign in again.'}
                </p>
              </div>
              <button
                type="button"
                className={btn.secondary}
                disabled={!!busy}
                onClick={() =>
                  run('active', async () =>
                    onSaved((await usersApi.update(user.id, { isActive: !user.isActive })).data, user.isActive ? `${user.fullName} disabled.` : `${user.fullName} enabled.`)
                  )
                }
              >
                {busy === 'active' && <Loader2 className="w-4 h-4 animate-spin" />}
                {user.isActive ? 'Disable' : 'Enable'}
              </button>
            </div>
            <div className="px-4 py-3">
              {!confirmDelete ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] font-medium text-slate-800">Delete account</p>
                    <p className="text-[12.5px] text-slate-500">Removes the login. Their employee record and attendance are kept.</p>
                  </div>
                  <button type="button" className={btn.secondary} disabled={!!busy} onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[13px] text-rose-800">Delete {user.fullName}&apos;s login? This can&apos;t be undone.</p>
                  <div className="flex gap-2">
                    <button type="button" className={btn.secondary} onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        run('delete', async () => {
                          await usersApi.remove(user.id);
                          onDeleted(user.id);
                        })
                      }
                      className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-rose-600 text-white text-[13px] font-medium shadow-sm hover:bg-rose-700 disabled:opacity-50"
                    >
                      {busy === 'delete' && <Loader2 className="w-4 h-4 animate-spin" />}
                      Delete login
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {!readOnly && (
        <div className="flex justify-end gap-2 px-5 sm:px-6 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
          <button type="button" className={btn.secondary} onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className={btn.primary} onClick={save} disabled={!valid || !!busy}>
            {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : user ? <Check className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
            {user ? 'Save changes' : 'Create user'}
          </button>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- page

export default function UsersPage() {
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [employees, setEmployees] = useState<Emp[]>([]);
  const [activity, setActivity] = useState<AccountActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserAccount | 'new' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const [u, r, a] = await Promise.all([usersApi.list(), usersApi.roles(), usersApi.activity(20)]);
      setUsers(u.data);
      setRoles(r.data);
      setActivity(a.data);
      setError(null);
      setNow(Date.now());
    } catch (e: any) {
      setError(e.message || 'Could not load users');
    }
  }, []);

  useEffect(() => {
    load();
    api
      .getEmployees()
      .then((r: any) => setEmployees((r.data ?? []).map((e: any) => ({ id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, isActive: e.isActive }))))
      .catch(() => setEmployees([]));
  }, [load]);

  const linked = useMemo(() => {
    const m = new Map<string, string>();
    users?.forEach((u) => u.employee && m.set(u.employee.id, u.fullName));
    return m;
  }, [users]);

  const notify = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    users?.forEach((u) => (c[u.role] = (c[u.role] ?? 0) + 1));
    return c;
  }, [users]);

  return (
    <>
      <Header
        actions={
          <button type="button" className={btn.primary} onClick={() => setEditing('new')}>
            <Plus className="w-4 h-4" /> Add user
          </button>
        }
      />
      <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 space-y-4 max-w-[1440px] w-full mx-auto">
        <div className="md:hidden">
          <button type="button" className={`${btn.primary} w-full`} onClick={() => setEditing('new')}>
            <Plus className="w-4 h-4" /> Add user
          </button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}

        <Card>
          <CardHeader title="People who can sign in" description="Each person signs in with their own email and password." />
          {users === null ? (
            <div className="px-5 pb-5 space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : users.length === 0 ? (
            <EmptyState icon={UserPlus} title="No users yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[12px] text-slate-500 border-y border-slate-100 bg-slate-50/60">
                    <th className="font-medium py-2.5 pl-5 pr-3">Person</th>
                    <th className="font-medium py-2.5 px-3">Access</th>
                    <th className="font-medium py-2.5 px-3 hidden md:table-cell">Employee record</th>
                    <th className="font-medium py-2.5 px-3">Status</th>
                    <th className="font-medium py-2.5 px-3 hidden sm:table-cell">Last sign-in</th>
                    <th className="py-2.5 pl-3 pr-5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map((u) => {
                    const st = statusOf(u);
                    return (
                      <tr key={u.id} className={u.isActive ? '' : 'text-slate-400'}>
                        <td className="py-3 pl-5 pr-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar name={u.fullName} id={u.id} size="sm" />
                            <div className="min-w-0">
                              <p className="font-medium text-slate-900 truncate">
                                {u.fullName}
                                {u.isYou && <span className="ml-1.5 text-[11.5px] font-normal text-slate-400">(you)</span>}
                              </p>
                              <p className="text-[12px] text-slate-500 truncate">{u.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <Tag tone={u.role === 'SUPER_ADMIN' || u.role === 'OFFICE_ADMIN' ? 'blue' : u.role === 'EMPLOYEE' ? 'slate' : 'emerald'}>{u.roleLabel}</Tag>
                        </td>
                        <td className="py-3 px-3 hidden md:table-cell text-slate-600">{u.employee ? u.employee.fullName : <span className="text-slate-400">—</span>}</td>
                        <td className="py-3 px-3">
                          <span className="inline-flex items-center gap-1.5 text-[12.5px] whitespace-nowrap">
                            <Dot tone={st.tone} /> {st.text}
                          </span>
                        </td>
                        <td className="py-3 px-3 hidden sm:table-cell text-slate-500 whitespace-nowrap">{u.lastLoginAt ? timeAgo(u.lastLoginAt, now) : 'Never'}</td>
                        <td className="py-3 pl-3 pr-5 text-right">
                          <button type="button" className={btn.secondary} onClick={() => setEditing(u)} aria-label={`Edit ${u.fullName}`}>
                            <Pencil className="w-4 h-4" /> <span className="hidden lg:inline">{u.canEdit ? 'Edit' : 'View'}</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title="Access levels" description="What each level can see and change. The server enforces these on every request." />
            <div className="overflow-x-auto pb-2">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-slate-500 border-y border-slate-100 bg-slate-50/60">
                    <th className="font-medium py-2.5 pl-5 pr-3">Level</th>
                    {PERM_COLUMNS.map((c) => (
                      <th key={c.perm} className="font-medium py-2.5 px-2 text-center whitespace-nowrap">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {roles.map((r) => (
                    <tr key={r.value}>
                      <td className="py-2.5 pl-5 pr-3 min-w-[16rem]">
                        <p className="font-medium text-slate-900">
                          {r.label}
                          <span className="ml-1.5 font-normal text-slate-400">{counts[r.value] ? `${counts[r.value]} user${counts[r.value] === 1 ? '' : 's'}` : ''}</span>
                        </p>
                        <p className="text-slate-500">{r.description}</p>
                      </td>
                      {PERM_COLUMNS.map((c) => (
                        <td key={c.perm} className="py-2.5 px-2 text-center">
                          {r.permissions.includes(c.perm) ? (
                            <Check className="w-4 h-4 text-emerald-600 inline" aria-label="Yes" />
                          ) : (
                            <Minus className="w-4 h-4 text-slate-300 inline" aria-label="No" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent account changes" />
            <ul className="px-5 pb-5 space-y-3">
              {activity === null ? (
                <Skeleton className="h-16 w-full" />
              ) : activity.length === 0 ? (
                <li className="text-[13px] text-slate-500">Nothing yet.</li>
              ) : (
                activity.map((a) => (
                  <li key={a.id} className="text-[12.5px]">
                    <p className="text-slate-700">
                      {a.action === 'USER_LOCKED' || a.action === 'USER_PASSWORD_CHANGED' ? (
                        <>
                          <span className="font-medium">{a.target ?? 'Someone'}</span> {a.text}
                        </>
                      ) : (
                        <>
                          <span className="font-medium">{a.actor ?? 'Someone'}</span> {a.text} of <span className="font-medium">{a.target ?? 'a deleted user'}</span>
                        </>
                      )}
                    </p>
                    {a.changes && Object.keys(a.changes).length > 0 && (
                      <p className="text-slate-500">
                        {Object.entries(a.changes)
                          .map(([k, [from, to]]) =>
                            k === 'role'
                              ? `access ${roles.find((r) => r.value === from)?.label ?? from} → ${roles.find((r) => r.value === to)?.label ?? to}`
                              : k === 'isActive'
                              ? to
                                ? 'enabled'
                                : 'disabled'
                              : k === 'employeeId'
                              ? 'linked employee changed'
                              : `${k === 'fullName' ? 'name' : k} changed`
                          )
                          .join(', ')}
                      </p>
                    )}
                    <p className="text-slate-400">{timeAgo(a.at, now)}</p>
                  </li>
                ))
              )}
            </ul>
          </Card>
        </div>
      </main>

      {editing && (
        <UserDialog
          user={editing === 'new' ? null : editing}
          roles={roles}
          employees={employees}
          linked={linked}
          onClose={() => setEditing(null)}
          onSaved={(u, m) => {
            setEditing(null);
            notify(m);
            load();
          }}
          onDeleted={() => {
            setEditing(null);
            notify('Login deleted.');
            load();
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-sm" role="status">
          <div className="flex items-center gap-2.5 rounded-xl px-4 py-3 text-[13px] shadow-lg ring-1 bg-slate-900 text-white ring-slate-900">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{toast}</span>
          </div>
        </div>
      )}
    </>
  );
}
