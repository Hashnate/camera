import {
  LayoutDashboard,
  Clock,
  CalendarCheck,
  Cctv,
  Users,
  Timer,
  Coffee,
  BarChart3,
  MapPin,
  Settings,
  UserCircle,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/lib/api';

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Shown under the page title when a page doesn't set its own subtitle. */
  description: string;
  /** Needed to see the page (the server enforces the same rule on its data). */
  perm: Permission;
  /** Only shown when the login is linked to an employee record. */
  needsEmployee?: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { name: 'Overview', href: '/dashboard', icon: LayoutDashboard, description: 'Who is in, and how today is going', perm: 'reports.view' },
      { name: 'My time', href: '/dashboard/me', icon: UserCircle, description: 'Your own office time and attendance', perm: 'self.view', needsEmployee: true },
    ],
  },
  {
    label: 'Today',
    items: [
      { name: 'Office Time', href: '/dashboard/office-time', icon: Clock, description: 'Time inside the office for every employee', perm: 'reports.view' },
      { name: 'Attendance', href: '/dashboard/attendance', icon: CalendarCheck, description: 'Check-ins, late arrivals and absences', perm: 'reports.view' },
      { name: 'Live Cameras', href: '/dashboard/cameras', icon: Cctv, description: 'Live view from the office cameras', perm: 'cameras.live' },
    ],
  },
  {
    label: 'People',
    items: [{ name: 'Employees', href: '/dashboard/employees', icon: Users, description: 'Staff records and face enrolment', perm: 'reports.view' }],
  },
  {
    label: 'Insights',
    items: [
      { name: 'Work Hours', href: '/dashboard/work-hours', icon: Timer, description: 'Time per room, from zone tracking', perm: 'reports.view' },
      { name: 'Breaks & Away', href: '/dashboard/breaks', icon: Coffee, description: 'Breaks and time away from the desk', perm: 'reports.view' },
      { name: 'Analytics', href: '/dashboard/analytics', icon: BarChart3, description: 'Occupancy trends', perm: 'reports.view' },
    ],
  },
  {
    label: 'Setup',
    items: [
      { name: 'Office Zones', href: '/dashboard/zones', icon: MapPin, description: 'Rooms and door lines for each camera', perm: 'setup.manage' },
      { name: 'Users & access', href: '/dashboard/users', icon: ShieldCheck, description: 'Who can sign in, and what each person can see and change', perm: 'users.manage' },
      { name: 'Settings', href: '/dashboard/settings', icon: Settings, description: 'Cameras, camera account and how recognition works', perm: 'setup.manage' },
    ],
  },
];

export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

/** Pages that need more than the nav item they sit under. */
const PAGE_PERMS: { prefix: string; perm: Permission }[] = [{ prefix: '/dashboard/employees/register', perm: 'people.manage' }];

export function isActive(item: NavItem, pathname: string) {
  return item.href === '/dashboard' ? pathname === '/dashboard' : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The nav item a path belongs to (most specific match). */
export function navItemFor(pathname: string): NavItem | undefined {
  return [...NAV_ITEMS].sort((a, b) => b.href.length - a.href.length).find((i) => isActive(i, pathname));
}

/** Permission needed to open a dashboard page. */
export function pagePermission(pathname: string): Permission | undefined {
  return PAGE_PERMS.find((p) => pathname === p.prefix || pathname.startsWith(`${p.prefix}/`))?.perm ?? navItemFor(pathname)?.perm;
}

/** Where to land after signing in: the first page this person can open. */
export function homeFor(perms: Permission[], hasEmployee: boolean): string {
  if (perms.includes('reports.view')) return '/dashboard';
  if (hasEmployee && perms.includes('self.view')) return '/dashboard/me';
  return '/dashboard/me';
}
