"""Who can do what: roles, their permissions, and which permission every API endpoint needs.

Every request from a signed-in user is checked against ACCESS_RULES in app.security.current_user.
An endpoint that matches no rule is refused, so a new endpoint can't be left open by accident: add a rule for it.

Endpoints that don't sign users in at all are outside this table: /api/auth/login, /api/health, the phone
enrolment link (/api/public/enroll, protected by its one-time token) and the AI service's /api/internal/* calls
(protected by the service key).
"""

import re
from enum import Enum
from typing import Optional

from app.models import UserRole


class Perm(str, Enum):
    SELF_VIEW = "self.view"  # own office time and attendance ("My time")
    REPORTS_VIEW = "reports.view"  # everyone's attendance, office time, breaks, analytics, employee list
    CAMERAS_LIVE = "cameras.live"  # live video and pictures from the cameras
    PEOPLE_MANAGE = "people.manage"  # add/edit employees, face enrolment, attendance and break corrections
    SETUP_MANAGE = "setup.manage"  # cameras, rooms (zones) and system settings
    USERS_MANAGE = "users.manage"  # user accounts and access levels


ALL = frozenset(Perm)

ROLE_PERMS: dict[UserRole, frozenset[Perm]] = {
    UserRole.SUPER_ADMIN: ALL,
    UserRole.OFFICE_ADMIN: ALL,
    UserRole.HR_MANAGER: frozenset({Perm.SELF_VIEW, Perm.REPORTS_VIEW, Perm.CAMERAS_LIVE, Perm.PEOPLE_MANAGE}),
    UserRole.SUPERVISOR: frozenset({Perm.SELF_VIEW, Perm.REPORTS_VIEW, Perm.CAMERAS_LIVE}),
    UserRole.VIEWER: frozenset({Perm.SELF_VIEW, Perm.REPORTS_VIEW}),
    UserRole.EMPLOYEE: frozenset({Perm.SELF_VIEW}),
}

# Shown in the dashboard (Users & access).
ROLE_INFO: dict[UserRole, tuple[str, str]] = {
    UserRole.SUPER_ADMIN: ("Super admin", "Everything, including managing other super admins."),
    UserRole.OFFICE_ADMIN: ("Admin", "Everything: users, cameras, settings and employees. Can't change super-admin accounts."),
    UserRole.HR_MANAGER: ("HR manager", "Employees, face enrolment, attendance and break corrections, all reports and live cameras."),
    UserRole.SUPERVISOR: ("Supervisor", "Sees all reports and live cameras. Can't change anything."),
    UserRole.VIEWER: ("Viewer", "Sees attendance and office-time reports only. No live video or face photos."),
    UserRole.EMPLOYEE: ("Employee", "Sees only their own office time and attendance."),
}

# Roles an Admin (not a Super admin) may not create, edit, reset or delete.
PROTECTED_ROLES = frozenset({UserRole.SUPER_ADMIN})


def perms_for(role: UserRole) -> frozenset[Perm]:
    return ROLE_PERMS.get(role, frozenset())


ANY_USER = "any"  # signed in, whatever the role

# (methods, path regex, required permission). First match wins.
_R = list[tuple[frozenset[str], re.Pattern, object]]
GET = frozenset({"GET", "HEAD"})
WRITE = frozenset({"POST", "PUT", "PATCH", "DELETE"})
EVERY = GET | WRITE


def _rule(methods: frozenset[str], pattern: str, perm) -> tuple:
    return methods, re.compile(rf"^{pattern}/?$"), perm


ACCESS_RULES: _R = [
    # Own account
    _rule(GET, r"/api/auth/me", ANY_USER),
    _rule(frozenset({"POST"}), r"/api/auth/(logout|change-password)", ANY_USER),
    # Own records
    _rule(GET, r"/api/me/[\w-]+", Perm.SELF_VIEW),
    _rule(GET, r"/api/attendance/me/(today|history)", Perm.SELF_VIEW),
    # Self check-in/out; checking in someone else is re-checked in the endpoint (people.manage).
    _rule(frozenset({"POST"}), r"/api/attendance/check-(in|out)", Perm.SELF_VIEW),
    # User accounts
    _rule(EVERY, r"/api/users(/.*)?", Perm.USERS_MANAGE),
    # Settings
    _rule(GET, r"/api/settings", Perm.SETUP_MANAGE),
    _rule(WRITE, r"/api/settings/.+", Perm.SETUP_MANAGE),
    # Work schedules
    _rule(GET, r"/api/work-schedules(/.*)?", Perm.REPORTS_VIEW),
    _rule(WRITE, r"/api/work-schedules(/.*)?", Perm.SETUP_MANAGE),
    # Cameras: setup
    _rule(GET, r"/api/cameras/(brands|discover|scan)", Perm.SETUP_MANAGE),
    _rule(frozenset({"POST"}), r"/api/cameras(/(onvif|test|sync-ezviz))?", Perm.SETUP_MANAGE),
    _rule(frozenset({"PATCH", "DELETE"}), r"/api/cameras/[^/]+", Perm.SETUP_MANAGE),
    _rule(frozenset({"PUT"}), r"/api/cameras/[^/]+/zone-config", Perm.SETUP_MANAGE),
    # Cameras: live pictures
    _rule(EVERY, r"/api/cameras/[^/]+/(preview|snapshot|status|stream)", Perm.CAMERAS_LIVE),
    # Cameras: names and rooms (no video)
    _rule(GET, r"/api/cameras(/[^/]+)?", Perm.REPORTS_VIEW),
    _rule(GET, r"/api/cameras/[^/]+/zone-config", Perm.REPORTS_VIEW),
    _rule(GET, r"/api/zones", Perm.REPORTS_VIEW),
    # Employees
    _rule(GET, r"/api/employees(/.*)?", Perm.REPORTS_VIEW),
    _rule(WRITE, r"/api/employees(/.*)?", Perm.PEOPLE_MANAGE),
    # Faces: who is enrolled is a report; photos and enrolment are HR work
    _rule(GET, r"/api/faces", Perm.REPORTS_VIEW),
    _rule(EVERY, r"/api/faces/.+", Perm.PEOPLE_MANAGE),
    # Attendance
    _rule(GET, r"/api/attendance/(today|history)", Perm.REPORTS_VIEW),
    _rule(EVERY, r"/api/attendance/(correction|reviews(/.*)?)", Perm.PEOPLE_MANAGE),
    # Breaks
    _rule(GET, r"/api/breaks/.+", Perm.REPORTS_VIEW),
    _rule(WRITE, r"/api/breaks/.+", Perm.PEOPLE_MANAGE),
    # Tracking
    _rule(frozenset({"POST"}), r"/api/tracking/daily/[^/]+/(correct|close)", Perm.PEOPLE_MANAGE),
    _rule(GET, r"/api/tracking(/.*)?", Perm.REPORTS_VIEW),
    # Reports
    _rule(GET, r"/api/(presence|recognition|analytics|work-hours)/.+", Perm.REPORTS_VIEW),
]


def required_permission(method: str, path: str) -> Optional[object]:
    """The permission an endpoint needs, ANY_USER, or None when no rule matches (refused)."""
    for methods, pattern, perm in ACCESS_RULES:
        if method in methods and pattern.match(path):
            return perm
    return None


# What each permission means, for messages.
PERM_TEXT = {
    Perm.SELF_VIEW: "see your own records",
    Perm.REPORTS_VIEW: "see reports",
    Perm.CAMERAS_LIVE: "see live cameras",
    Perm.PEOPLE_MANAGE: "manage employees and attendance",
    Perm.SETUP_MANAGE: "change cameras and settings",
    Perm.USERS_MANAGE: "manage user accounts",
}
