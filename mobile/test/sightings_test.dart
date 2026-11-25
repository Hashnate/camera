import 'package:flutter_test/flutter_test.dart';
import 'package:worksight/api/models.dart';
import 'package:worksight/sightings.dart';

DateTime t(String hm, [String s = '00']) => DateTime.parse('2026-11-25T$hm:$s.000Z');

Sighting seen(String hm, {int lens = 1, double sim = 0.55, bool arrived = false}) =>
    Sighting(seenAt: t(hm), arrived: arrived, similarity: sim, channelNo: lens);

Span span(String a, String b) => Span(t(a), t(b), t(b).difference(t(a)).inSeconds);

void main() {
  final sightings = [
    seen('03:00', arrived: true, sim: 0.74),
    seen('03:20', lens: 2),
    seen('04:00', lens: 2, sim: 0.48),
    seen('04:30', sim: 0.62), // after the first stay ended, before the second began: goes with the first
    seen('05:10', lens: 2, sim: 0.71),
    seen('05:12'),
  ];
  final sessions = [span('03:00', '04:05'), span('05:00', '05:12')];

  test('sightings go into the stay they fall in, the last stay runs until now while they are in', () {
    final stays = staysOf(sightings, sessions, ongoing: true, now: t('05:30'));
    expect(stays, hasLength(2));
    expect(stays[0].sightings.map((s) => s.seenAt), [t('03:00'), t('03:20'), t('04:00'), t('04:30')]);
    expect(stays[1].sightings.map((s) => s.seenAt), [t('05:10'), t('05:12')]);
    expect(stays[0].ongoing, isFalse);
    expect(stays[1].ongoing, isTrue);
    expect(stays[1].end, t('05:30'));
    expect(stays[0].best, 0.74);
    expect(stays[0].hasArrival, isTrue);
    expect(stays[0].perLens, [(1, 2), (2, 2)]);
  });

  test('a finished day keeps the stay ends as they were', () {
    final stays = staysOf(sightings, sessions, ongoing: false, now: t('23:00'));
    expect(stays.last.end, t('05:12'));
    expect(stays.last.ongoing, isFalse);
  });

  test('no sessions: one stay from the first to the last sighting', () {
    final stays = staysOf(sightings, const [], ongoing: false, now: t('23:00'));
    expect(stays, hasLength(1));
    expect(stays.single.sightings, hasLength(6));
    expect(stays.single.start, t('03:00'));
    expect(stays.single.end, t('05:12'));
  });

  test('hours run from the first to the last sighting, empty hours included', () {
    final hours = hoursOf(sightings);
    expect(hours.map((h) => h.sightings.length), [2, 2, 2]);
    expect(hoursOf([seen('03:10'), seen('05:40')]).map((h) => h.sightings.length), [1, 0, 1]);
    expect(hours.first.minutes, {0, 20});
  });

  test('summary counts lenses and match strength', () {
    final st = SightingStats.of(sightings);
    expect(st.total, 6);
    expect(st.perLens, [(1, 3), (2, 3)]);
    expect((st.strong, st.fair, st.weak), (3, 2, 1));
    expect(st.first, t('03:00'));
    expect(st.last, t('05:12'));
  });
}
