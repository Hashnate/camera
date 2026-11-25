import 'package:flutter_test/flutter_test.dart';
import 'package:worksight/api/models.dart';
import 'package:worksight/widgets/charts.dart';

WorkDayRow row(String id, String state, List<(String, String)> sessions) => WorkDayRow.fromJson({
      'employee': {'id': id, 'fullName': 'Person $id', 'employeeCode': id},
      'state': state,
      'insideSeconds': 0,
      'sessions': [
        for (final (s, e) in sessions)
          {'start': '2026-11-25T$s:00.000Z', 'end': '2026-11-25T$e:00.000Z', 'seconds': 60},
      ],
      'awayPeriods': [],
    });

DateTime utc(String hm) => DateTime.parse('2026-11-25T$hm:00.000Z').toLocal();

void main() {
  test('occupancy counts people inside, steps at each arrival and departure, peak included', () {
    final rows = [
      // In 03:00-04:00 and back 04:30, still in the office now.
      row('a', 'IN_OFFICE', [('03:00', '04:00'), ('04:30', '05:50')]),
      // In 03:30-05:00 and gone.
      row('b', 'LEFT', [('03:30', '05:00')]),
      row('c', 'ABSENT', []),
    ];
    final occ = Occupancy.of(rows, start: utc('02:30'), end: utc('12:30'), now: utc('06:00'), isToday: true);

    final counts = [for (final (t, c) in occ.steps) (t.toUtc().toIso8601String().substring(11, 16), c)];
    expect(counts, [('02:30', 0), ('03:00', 1), ('03:30', 2), ('04:00', 1), ('04:30', 2), ('05:00', 1)]);
    expect(occ.peak, 2);
    // Still in the office: counted until now, not just until their last sighting at 05:50.
    expect(occ.until, utc('06:00'));
  });

  test('a past day runs to the end of the window and nobody is extended to now', () {
    final rows = [
      row('a', 'LEFT', [('03:00', '11:00')])
    ];
    final occ = Occupancy.of(rows, start: utc('02:30'), end: utc('12:30'), now: utc('20:00'), isToday: false);
    final counts = [for (final (_, c) in occ.steps) c];
    expect(counts, [0, 1, 0]);
    expect(occ.until, utc('12:30'));
  });
}
