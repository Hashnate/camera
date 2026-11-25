import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worksight/main.dart';
import 'package:worksight/session.dart';
import 'package:worksight/widgets/sightings_section.dart';

import 'fixtures.dart';

/// A fake WorkSight server answering the calls the app makes.
MockClient fakeServer({List<String>? calls}) {
  final daily = jsonDecode(jsonEncode(dailyJson)) as Map<String, dynamic>;
  // A long name and team, to catch text that doesn't fit a small phone.
  (daily['data'] as List).add({
    'employee': {
      'id': 'e3',
      'fullName': 'Mohammed Abdul Rahman Fernando-Wickramasinghe',
      'employeeCode': 'EMP-000123456',
      'department': 'Information Technology and Infrastructure Services',
    },
    'state': 'LEFT',
    'date': '2026-11-24',
    'firstSeen': '2026-11-24T03:20:00.000Z',
    'lastSeen': '2026-11-24T04:10:00.000Z',
    'insideSeconds': 2700,
    'awaySeconds': 1260,
    'longestAwaySeconds': 1260,
    'isLate': true,
    'lateByMinutes': 125,
    'scheduledMinutes': 480,
    'sessions': [
      {'start': '2026-11-24T03:20:00.000Z', 'end': '2026-11-24T03:45:00.000Z', 'seconds': 1500},
      {'start': '2026-11-24T04:06:00.000Z', 'end': '2026-11-24T04:10:00.000Z', 'seconds': 240},
    ],
    'awayPeriods': [
      {'start': '2026-11-24T03:45:00.000Z', 'end': '2026-11-24T04:06:00.000Z', 'seconds': 1260},
    ],
  });

  return MockClient((req) async {
    calls?.add('${req.method} ${req.url.path}');
    Object body;
    switch (req.url.path) {
      case '/api/auth/me':
        body = {
          'success': true,
          'user': {
            'id': 'u1',
            'email': 'maya@example.com',
            'fullName': 'Maya Manager',
            'roleLabel': 'Admin',
            'permissions': ['reports.view', 'cameras.live'],
            'mustChangePassword': false,
            'company': {'name': 'Hashnate'},
          },
        };
      case '/api/work-hours/daily':
        body = daily;
      case '/api/recognition/status':
        body = {
          'success': true,
          'data': {
            'reachable': true,
            'running': true,
            'channels': [
              {
                'cameraId': 'cam1',
                'cameraName': 'Hall',
                'channelNo': 1,
                'state': 'running',
                'lastFrameAt': DateTime.now().toUtc().toIso8601String()
              },
            ],
          },
        };
      case '/api/recognition/events':
        body = {
          'success': true,
          'data': [
            {
              'id': 'ev1',
              'employeeId': 'e1',
              'channelNo': 1,
              'similarity': 0.8,
              'action': 'CHECK_IN',
              'seenAt': '2026-11-24T03:41:00.000Z',
              'employee': {'fullName': 'Ana Silva'}
            },
          ],
        };
      case '/api/cameras':
        body = {
          'success': true,
          'data': [
            {
              'id': 'cam1',
              'name': 'Hall',
              'location': 'Front door',
              'isEnabled': true,
              'channels': [
                {'channelNo': 1, 'channelName': 'Wide lens', 'recognitionEnabled': true},
              ],
            },
          ],
        };
      case '/api/work-hours/e1/sightings':
        body = {
          'success': true,
          'data': [
            {'seenAt': '2026-11-24T03:41:00.000Z', 'action': 'CHECK_IN', 'similarity': 0.81, 'channelNo': 1},
            {'seenAt': '2026-11-24T04:34:00.000Z', 'action': 'SEEN', 'similarity': 0.55, 'channelNo': 2},
          ],
        };
      case '/api/auth/logout':
        body = {'success': true};
      default:
        return http.Response(jsonEncode({'success': false, 'message': 'Not found'}), 404);
    }
    return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
  });
}

Future<Session> signedInSession(MockClient server) async {
  FlutterSecureStorage.setMockInitialValues(
      {'server': 'https://demo.example', 'token': 'tok', 'email': 'maya@example.com'});
  final session = Session(httpClient: server);
  await session.restore();
  return session;
}

void main() {
  testWidgets('a manager can use every tab on a small phone', (tester) async {
    tester.view.physicalSize = const Size(360 * 3, 740 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    final calls = <String>[];
    final session = await signedInSession(fakeServer(calls: calls));
    expect(session.signedIn, isTrue);

    await tester.pumpWidget(WorkSightApp(session: session));
    await tester.pumpAndSettle();

    // Today
    expect(find.text('In the office now'), findsOneWidget);
    expect(find.text('Ana Silva'), findsWidgets);
    expect(find.text('Live'), findsWidgets);
    await tester.scrollUntilVisible(find.text('Recent sightings'), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Recent sightings'), findsOneWidget);

    // Office time
    await tester.tap(find.text('Office time'));
    await tester.pumpAndSettle();
    expect(find.text('Search name, code, team'), findsOneWidget);
    expect(find.text('Mohammed Abdul Rahman Fernando-Wickramasinghe'), findsWidgets);

    // Filter: late only
    await tester.ensureVisible(find.textContaining('Late  '));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Late  '));
    await tester.pumpAndSettle();
    expect(find.text('Ben Perera'), findsNothing);

    // Search
    await tester.enterText(find.byType(TextField), 'ana');
    await tester.pumpAndSettle();
    expect(find.text('Mohammed Abdul Rahman Fernando-Wickramasinghe'), findsNothing);

    // One person's day
    await tester.tap(find.text('Ana Silva').last);
    await tester.pumpAndSettle();
    expect(find.text('Day at a glance'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Face sightings'), 300, scrollable: find.byType(Scrollable).last);
    expect(calls, contains('GET /api/work-hours/e1/sightings'));

    // Sightings by stay (the default): the latest stay is open, the first one (with the arrival) opens on a tap.
    expect(find.text('ARRIVED'), findsNothing);
    await tester.ensureVisible(find.byKey(const ValueKey('stay-header-0')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('stay-header-0')));
    await tester.pumpAndSettle();
    expect(find.text('ARRIVED'), findsOneWidget);
    expect(find.textContaining('away 4m'), findsOneWidget); // between the two stays

    // By hour, then the summary and its full list.
    await tester.ensureVisible(find.text('By hour'));
    await tester.tap(find.text('By hour'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('hour-row-0')), findsOneWidget);
    await tester.tap(find.text('Summary'));
    await tester.pumpAndSettle();
    expect(find.text('Which camera'), findsOneWidget);
    await tester.ensureVisible(find.text('See all 2 sightings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('See all 2 sightings'));
    await tester.pumpAndSettle();
    expect(find.text('All sightings'), findsOneWidget);
    await tester.ensureVisible(find.text('Lens 2 · 1')); // the filter row scrolls sideways
    await tester.pumpAndSettle();
    await tester.tap(find.text('Lens 2 · 1'));
    await tester.pumpAndSettle();
    final list = find.byType(AllSightingsScreen);
    expect(find.descendant(of: list, matching: find.text('ARRIVED')), findsNothing); // the arrival was on lens 1
    expect(find.descendant(of: list, matching: find.text('Lens 2')), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('By stay'));
    await tester.tap(find.text('By stay'));
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();

    // Cameras
    await tester.tap(find.text('Cameras'));
    await tester.pumpAndSettle();
    expect(find.text('Wide lens'), findsOneWidget);

    // More -> sign out
    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    expect(find.text('Maya Manager'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Sign out'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Sign out'));
    await tester.pumpAndSettle();
    expect(find.text('Sign in with your manager account'), findsOneWidget);
    expect(calls, contains('POST /api/auth/logout'));

    await tester.pumpWidget(const SizedBox()); // stop refresh timers
  });

  testWidgets('employees are turned away at sign-in', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = MockClient((req) async {
      switch (req.url.path) {
        case '/api/health':
          return http.Response(jsonEncode({'status': 'ok', 'service': 'WorkSight Backend API'}), 200);
        case '/api/auth/login':
          return http.Response(
            jsonEncode({
              'success': true,
              'token': 't',
              'user': {
                'id': 'u2',
                'fullName': 'Eve',
                'roleLabel': 'Employee',
                'permissions': ['self.view']
              },
            }),
            200,
          );
        default:
          return http.Response(jsonEncode({'success': true}), 200);
      }
    });
    final session = Session(httpClient: server);
    await session.restore();
    await tester.pumpWidget(WorkSightApp(session: session));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'demo.example');
    await tester.enterText(find.byType(TextFormField).at(1), 'eve@example.com');
    await tester.enterText(find.byType(TextFormField).at(2), 'secret');
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();

    expect(find.textContaining('This app is for managers'), findsOneWidget);
    expect(session.signedIn, isFalse);
  });
}
