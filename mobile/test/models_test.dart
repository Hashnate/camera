import 'package:flutter_test/flutter_test.dart';
import 'package:worksight/api/models.dart';

import 'fixtures.dart';

void main() {
  test('parses the daily office-time report', () {
    final d = DailyReport.fromJson(dailyJson);
    expect(d.isToday, isTrue);
    expect(d.awayAfterMinutes, 5);
    expect(d.summary.inOfficeNow, 1);
    expect(d.rows, hasLength(2));

    final ana = d.rowFor('e1')!;
    expect(ana.state, PresenceState.inOffice);
    expect(ana.employee.jobTitle, isNull, reason: 'blank job title is treated as none');
    expect(ana.employee.department, 'Ops');
    expect(ana.sessions, hasLength(2));
    expect(ana.awayPeriods.single.seconds, 240);
    expect(ana.schedule!.graceMinutes, 10);
    expect(ana.percentOfSchedule, 26); // 125 of 480 minutes
    expect(ana.isLate, isTrue);
    expect(ana.arrived!.isUtc, isFalse, reason: 'times are shown in the phone\'s local time');

    final ben = d.rowFor('e2')!;
    expect(ben.wasSeen, isFalse);
    expect(ben.state, PresenceState.absent);
    expect(ben.percentOfSchedule, isNull);
  });

  test('a malformed row does not crash parsing', () {
    final d = DailyReport.fromJson({
      'date': '2026-11-24',
      'today': '2026-11-24',
      'data': [
        {'employee': null, 'sessions': 'oops', 'state': 'WHAT'},
      ],
    });
    expect(d.rows.single.state, PresenceState.absent);
    expect(d.rows.single.sessions, isEmpty);
  });

  test('only people who can see reports count as managers', () {
    final manager = SessionUser.fromJson({
      'id': 'u1',
      'fullName': 'M',
      'permissions': ['reports.view', 'cameras.live']
    });
    final employee = SessionUser.fromJson({
      'id': 'u2',
      'fullName': 'E',
      'permissions': ['self.view']
    });
    expect(manager.isManager, isTrue);
    expect(employee.isManager, isFalse);
  });

  test('recognition health', () {
    expect(RecognitionStatus.unreachable('down').health, Health.offline);
    final live = RecognitionStatus.fromJson({
      'reachable': true,
      'running': true,
      'channels': [
        {'cameraId': 'c', 'cameraName': 'Hall', 'channelNo': 1, 'state': 'running'},
      ],
    });
    expect(live.health, Health.live);
    expect(live.channel('c', 1)!.running, isTrue);
    expect(RecognitionStatus.fromJson({'reachable': true, 'running': true, 'channels': []}).health, Health.degraded);
  });
}
