// Test data shaped like the WorkSight backend's responses.

/// Shaped like GET /api/work-hours/daily from the backend.
final dailyJson = <String, dynamic>{
  'success': true,
  'date': '2026-11-24',
  'today': '2026-11-24',
  'isToday': true,
  'settings': {'presenceGapMin': 5, 'defaultPresenceGapMin': 5},
  'summary': {'employees': 2, 'present': 1, 'inOfficeNow': 1, 'totalInsideMinutes': 125, 'avgInsideMinutes': 125},
  'data': [
    {
      'employee': {'id': 'e1', 'fullName': 'Ana Silva', 'employeeCode': 'EMP-1', 'jobTitle': '', 'department': 'Ops'},
      'scheduledMinutes': 480,
      'state': 'IN_OFFICE',
      'date': '2026-11-24',
      'checkIn': '2026-11-24T03:40:00.000Z',
      'firstSeen': '2026-11-24T03:41:00.000Z',
      'lastSeen': '2026-11-24T05:50:00.000Z',
      'insideSeconds': 7500,
      'spanMinutes': 129,
      'awaySeconds': 240,
      'sightings': 40,
      'isLate': true,
      'lateByMinutes': 11,
      'longestAwaySeconds': 240,
      'schedule': {
        'name': 'Default',
        'start': '09:00',
        'end': '17:00',
        'graceMinutes': 10,
        'startAt': '2026-11-24T03:30:00.000Z',
        'endAt': '2026-11-24T11:30:00.000Z',
      },
      'sessions': [
        {'start': '2026-11-24T03:41:00.000Z', 'end': '2026-11-24T04:30:00.000Z', 'seconds': 2940},
        {'start': '2026-11-24T04:34:00.000Z', 'end': '2026-11-24T05:50:00.000Z', 'seconds': 4560},
      ],
      'awayPeriods': [
        {'start': '2026-11-24T04:30:00.000Z', 'end': '2026-11-24T04:34:00.000Z', 'seconds': 240},
      ],
    },
    {
      'employee': {'id': 'e2', 'fullName': 'Ben Perera', 'employeeCode': 'EMP-2', 'department': null},
      'scheduledMinutes': null,
      'state': 'ABSENT',
      'date': null,
      'checkIn': null,
      'firstSeen': null,
      'lastSeen': null,
      'insideSeconds': 0,
      'sessions': [],
      'awayPeriods': [],
      'schedule': null,
    },
  ],
};
