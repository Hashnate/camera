/// Data the WorkSight server sends to the app. Parsing is forgiving: a missing or odd field becomes an empty
/// value instead of crashing a screen.
library;

int _int(Object? v) => v is num ? v.round() : 0;
double _dbl(Object? v) => v is num ? v.toDouble() : 0;
String _str(Object? v) => v?.toString() ?? '';
String? _optStr(Object? v) => v?.toString();
String? _nonEmpty(Object? v) {
  final s = v?.toString().trim() ?? '';
  return s.isEmpty ? null : s;
}

bool _bool(Object? v) => v == true;
DateTime? _time(Object? v) => v is String ? DateTime.tryParse(v)?.toLocal() : null;
Map<String, dynamic> _map(Object? v) => v is Map ? v.cast<String, dynamic>() : const {};
List<Map<String, dynamic>> _list(Object? v) =>
    v is List ? v.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : const [];

// ---------------------------------------------------------------- sign-in

class SessionUser {
  SessionUser({
    required this.id,
    required this.email,
    required this.fullName,
    required this.roleLabel,
    required this.permissions,
    required this.mustChangePassword,
    this.companyName,
  });

  final String id;
  final String email;
  final String fullName;
  final String roleLabel;
  final List<String> permissions;
  final bool mustChangePassword;
  final String? companyName;

  bool can(String permission) => permissions.contains(permission);

  /// The app is for managers: people who can see everyone's reports.
  bool get isManager => can('reports.view');

  factory SessionUser.fromJson(Map<String, dynamic> j) => SessionUser(
        id: _str(j['id']),
        email: _str(j['email']),
        fullName: _str(j['fullName']),
        roleLabel: _str(j['roleLabel']),
        permissions:
            (j['permissions'] is List) ? (j['permissions'] as List).map((e) => e.toString()).toList() : const [],
        mustChangePassword: _bool(j['mustChangePassword']),
        companyName: _optStr(_map(j['company'])['name']),
      );
}

// ---------------------------------------------------------------- office time

/// A stretch of time: inside (continuous sightings) or away (unseen for longer than the away threshold).
class Span {
  Span(this.start, this.end, this.seconds);
  final DateTime start;
  final DateTime end;
  final int seconds;

  static Span? fromJson(Map<String, dynamic> j) {
    final s = _time(j['start']);
    final e = _time(j['end']);
    if (s == null || e == null) return null;
    return Span(s, e, _int(j['seconds']));
  }
}

class Schedule {
  Schedule(
      {required this.start, required this.end, required this.graceMinutes, required this.startAt, required this.endAt});
  final String start; // "09:00"
  final String end;
  final int graceMinutes;
  final DateTime startAt;
  final DateTime endAt;

  static Schedule? fromJson(Object? v) {
    final j = _map(v);
    final s = _time(j['startAt']);
    final e = _time(j['endAt']);
    if (j.isEmpty || s == null || e == null) return null;
    return Schedule(
        start: _str(j['start']), end: _str(j['end']), graceMinutes: _int(j['graceMinutes']), startAt: s, endAt: e);
  }
}

class EmployeeRef {
  EmployeeRef({required this.id, required this.fullName, required this.employeeCode, this.jobTitle, this.department});
  final String id;
  final String fullName;
  final String employeeCode;
  final String? jobTitle;
  final String? department;

  factory EmployeeRef.fromJson(Map<String, dynamic> j) {
    final dept = j['department'];
    return EmployeeRef(
      id: _str(j['id']),
      fullName: _str(j['fullName']),
      employeeCode: _str(j['employeeCode']),
      jobTitle: _nonEmpty(j['jobTitle']),
      department: _nonEmpty(dept is Map ? dept['name'] : dept),
    );
  }

  String get firstName => fullName.split(' ').first;
}

enum PresenceState { inOffice, left, absent }

/// One person's day, reconstructed from camera sightings.
class WorkDayRow {
  WorkDayRow({
    required this.employee,
    required this.state,
    required this.date,
    required this.checkIn,
    required this.firstSeen,
    required this.lastSeen,
    required this.insideSeconds,
    required this.spanMinutes,
    required this.awaySeconds,
    required this.sightings,
    required this.isLate,
    required this.lateByMinutes,
    required this.longestAwaySeconds,
    required this.scheduledMinutes,
    required this.schedule,
    required this.sessions,
    required this.awayPeriods,
  });

  final EmployeeRef employee;
  final PresenceState state;

  /// Null when the person wasn't seen on this day.
  final String? date;
  final DateTime? checkIn;
  final DateTime? firstSeen;
  final DateTime? lastSeen;
  final int insideSeconds;
  final int spanMinutes;
  final int awaySeconds;
  final int sightings;
  final bool isLate;
  final int lateByMinutes;
  final int longestAwaySeconds;
  final int? scheduledMinutes;
  final Schedule? schedule;
  final List<Span> sessions;
  final List<Span> awayPeriods;

  bool get wasSeen => date != null;
  DateTime? get arrived => firstSeen ?? checkIn;

  /// Share of the scheduled work day spent inside, 0-100.
  int? get percentOfSchedule {
    final s = scheduledMinutes;
    if (s == null || s <= 0) return null;
    return ((insideSeconds / 60 / s) * 100).round().clamp(0, 100);
  }

  factory WorkDayRow.fromJson(Map<String, dynamic> j) => WorkDayRow(
        employee: EmployeeRef.fromJson(_map(j['employee'])),
        state: switch (j['state']) {
          'IN_OFFICE' => PresenceState.inOffice,
          'LEFT' => PresenceState.left,
          _ => PresenceState.absent,
        },
        date: _optStr(j['date']),
        checkIn: _time(j['checkIn']),
        firstSeen: _time(j['firstSeen']),
        lastSeen: _time(j['lastSeen']),
        insideSeconds: _int(j['insideSeconds']),
        spanMinutes: _int(j['spanMinutes']),
        awaySeconds: _int(j['awaySeconds']),
        sightings: _int(j['sightings']),
        isLate: _bool(j['isLate']),
        lateByMinutes: _int(j['lateByMinutes']),
        longestAwaySeconds: _int(j['longestAwaySeconds']),
        scheduledMinutes: j['scheduledMinutes'] is num ? _int(j['scheduledMinutes']) : null,
        schedule: Schedule.fromJson(j['schedule']),
        sessions: _list(j['sessions']).map(Span.fromJson).whereType<Span>().toList(),
        awayPeriods: _list(j['awayPeriods']).map(Span.fromJson).whereType<Span>().toList(),
      );
}

class DailySummary {
  DailySummary(
      {required this.employees,
      required this.present,
      required this.inOfficeNow,
      required this.totalInsideMinutes,
      required this.avgInsideMinutes});
  final int employees;
  final int present;
  final int? inOfficeNow;
  final int totalInsideMinutes;
  final int avgInsideMinutes;

  factory DailySummary.fromJson(Map<String, dynamic> j) => DailySummary(
        employees: _int(j['employees']),
        present: _int(j['present']),
        inOfficeNow: j['inOfficeNow'] is num ? _int(j['inOfficeNow']) : null,
        totalInsideMinutes: _int(j['totalInsideMinutes']),
        avgInsideMinutes: _int(j['avgInsideMinutes']),
      );
}

/// Everyone's office time on one day.
class DailyReport {
  DailyReport(
      {required this.date,
      required this.today,
      required this.awayAfterMinutes,
      required this.summary,
      required this.rows});

  /// The day shown, "YYYY-MM-DD" in the office's time zone.
  final String date;

  /// Today's date in the office's time zone (the server decides, not the phone).
  final String today;
  final int awayAfterMinutes;
  final DailySummary summary;
  final List<WorkDayRow> rows;

  bool get isToday => date == today;

  WorkDayRow? rowFor(String employeeId) {
    for (final r in rows) {
      if (r.employee.id == employeeId) return r;
    }
    return null;
  }

  factory DailyReport.fromJson(Map<String, dynamic> j) => DailyReport(
        date: _str(j['date']),
        today: _str(j['today']),
        awayAfterMinutes: _int(_map(j['settings'])['presenceGapMin']).clamp(1, 1440),
        summary: DailySummary.fromJson(_map(j['summary'])),
        rows: _list(j['data']).map(WorkDayRow.fromJson).toList(),
      );
}

class Sighting {
  Sighting(
      {required this.seenAt,
      required this.arrived,
      required this.similarity,
      required this.channelNo,
      this.cameraName});
  final DateTime seenAt;
  final bool arrived;
  final double similarity;
  final int channelNo;
  final String? cameraName;

  static Sighting? fromJson(Map<String, dynamic> j) {
    final t = _time(j['seenAt']);
    if (t == null) return null;
    return Sighting(
      seenAt: t,
      arrived: j['action'] == 'CHECK_IN',
      similarity: _dbl(j['similarity']),
      channelNo: _int(j['channelNo']),
      cameraName: _optStr(j['cameraName']),
    );
  }
}

// ---------------------------------------------------------------- system status

enum Health { live, degraded, offline }

class ChannelStatus {
  ChannelStatus(
      {required this.cameraId,
      required this.cameraName,
      required this.channelNo,
      required this.state,
      this.lastFrameAt,
      this.lastError});
  final String cameraId;
  final String cameraName;
  final int channelNo;

  /// starting | connecting | running | idle | error
  final String state;
  final DateTime? lastFrameAt;
  final String? lastError;

  bool get running => state == 'running';

  factory ChannelStatus.fromJson(Map<String, dynamic> j) => ChannelStatus(
        cameraId: _str(j['cameraId']),
        cameraName: _str(j['cameraName']),
        channelNo: _int(j['channelNo']),
        state: _str(j['state']),
        lastFrameAt: _time(j['lastFrameAt']),
        lastError: _optStr(j['lastError']),
      );
}

/// Whether face recognition is running (the thing that records attendance).
class RecognitionStatus {
  RecognitionStatus({required this.reachable, required this.running, required this.channels, this.error});
  final bool reachable;
  final bool running;
  final List<ChannelStatus> channels;
  final String? error;

  static RecognitionStatus unreachable(String message) =>
      RecognitionStatus(reachable: false, running: false, channels: const [], error: message);

  Health get health {
    if (!reachable) return Health.offline;
    if (running && channels.any((c) => c.running)) return Health.live;
    return Health.degraded;
  }

  ChannelStatus? channel(String cameraId, int channelNo) {
    for (final c in channels) {
      if (c.cameraId == cameraId && c.channelNo == channelNo) return c;
    }
    return null;
  }

  factory RecognitionStatus.fromJson(Map<String, dynamic> j) => RecognitionStatus(
        reachable: _bool(j['reachable']),
        running: _bool(j['running']),
        channels: _list(j['channels']).map(ChannelStatus.fromJson).toList(),
        error: _optStr(j['error']) ?? _optStr(j['lastError']),
      );
}

class RecognitionEvent {
  RecognitionEvent(
      {required this.id,
      required this.employeeId,
      required this.employeeName,
      required this.action,
      required this.seenAt,
      required this.channelNo});
  final String id;
  final String employeeId;
  final String employeeName;

  /// CHECK_IN | CHECK_OUT | SEEN | IGNORED_INACTIVE
  final String action;
  final DateTime seenAt;
  final int channelNo;

  static RecognitionEvent? fromJson(Map<String, dynamic> j) {
    final t = _time(j['seenAt']);
    if (t == null) return null;
    final emp = _map(j['employee']);
    return RecognitionEvent(
      id: _str(j['id']),
      employeeId: _str(j['employeeId']),
      employeeName: emp.isEmpty ? 'Someone' : _str(emp['fullName']),
      action: _str(j['action']),
      seenAt: t,
      channelNo: _int(j['channelNo']),
    );
  }
}

// ---------------------------------------------------------------- cameras

class CameraLens {
  CameraLens({required this.channelNo, required this.name, required this.recognitionEnabled});
  final int channelNo;
  final String name;
  final bool recognitionEnabled;

  factory CameraLens.fromJson(Map<String, dynamic> j) => CameraLens(
        channelNo: _int(j['channelNo']),
        name: _str(j['channelName']).isEmpty ? 'Lens ${_int(j['channelNo'])}' : _str(j['channelName']),
        recognitionEnabled: j['recognitionEnabled'] != false,
      );
}

class Camera {
  Camera(
      {required this.id,
      required this.name,
      required this.isEnabled,
      required this.lenses,
      this.location,
      this.connectionType = ''});
  final String id;
  final String name;
  final String? location;
  final bool isEnabled;
  final List<CameraLens> lenses;

  /// EZVIZ | RTSP | HTTP | USB
  final String connectionType;

  /// EZVIZ cloud cameras: a picture the AI service doesn't already have costs one call from the account's daily
  /// EZVIZ allowance (1,000/day), so the app must not poll them.
  bool get isEzviz => connectionType == 'EZVIZ';

  factory Camera.fromJson(Map<String, dynamic> j) {
    final lenses = _list(j['channels']).map(CameraLens.fromJson).toList();
    return Camera(
      id: _str(j['id']),
      name: _str(j['name']),
      location: _optStr(j['location']),
      isEnabled: j['isEnabled'] != false,
      connectionType: _str(j['connectionType']),
      lenses: lenses.isEmpty ? [CameraLens(channelNo: 1, name: _str(j['name']), recognitionEnabled: true)] : lenses,
    );
  }
}
