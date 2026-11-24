import 'package:flutter_test/flutter_test.dart';
import 'package:worksight/api/api_client.dart';
import 'package:worksight/format.dart';

void main() {
  group('fmtDur (same wording as the website)', () {
    test('seconds, minutes, hours', () {
      expect(fmtDur(45), '45s');
      expect(fmtDur(200), '3m 20s');
      expect(fmtDur(720), '12m');
      expect(fmtDur(7 * 3600 + 5 * 60), '7h 05m');
      expect(fmtDur(-5), '0s');
    });
    test('fmtMin', () => expect(fmtMin(90), '1h 30m'));
  });

  group('dates', () {
    test('shiftDate crosses months and years', () {
      expect(shiftDate('2026-11-30', 1), '2026-12-01');
      expect(shiftDate('2027-01-01', -1), '2026-12-31');
    });
    test('fmtDate', () => expect(fmtDate('2026-11-24', pattern: 'EEE d MMM'), 'Tue 24 Nov'));
    test('timeAgo', () {
      final now = DateTime(2026, 11, 24, 12, 0);
      expect(timeAgo(now.subtract(const Duration(seconds: 10)), now), 'just now');
      expect(timeAgo(now.subtract(const Duration(minutes: 4)), now), '4m ago');
      expect(timeAgo(DateTime(2026, 11, 24, 9, 5), now), '9:05 AM');
    });
  });

  test('initials', () {
    expect(initials('Mohammed Musny'), 'MM');
    expect(initials('  Ana '), 'A');
    expect(initials(''), '?');
  });

  group('server address', () {
    test('adds https and strips /api and slashes', () {
      expect(ApiClient.normalizeServer('worksight.hashnate.com'), 'https://worksight.hashnate.com');
      expect(ApiClient.normalizeServer(' https://worksight.hashnate.com/api/ '), 'https://worksight.hashnate.com');
      expect(ApiClient.normalizeServer('http://192.168.1.10:8000'), 'http://192.168.1.10:8000');
    });
    test('builds API URLs', () {
      final c = ApiClient('https://x.example');
      expect(c.uri('/work-hours/daily', {'date': '2026-11-24'}).toString(),
          'https://x.example/api/work-hours/daily?date=2026-11-24');
      expect(c.previewUri('cam1', 2, bust: 7).toString(), 'https://x.example/api/cameras/cam1/preview?channel=2&t=7');
    });
  });
}
