import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worksight/main.dart';
import 'package:worksight/session.dart';

void main() {
  testWidgets('first launch shows the sign-in screen with a server field', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final session = Session();
    await session.restore();
    await tester.pumpWidget(WorkSightApp(session: session));
    await tester.pumpAndSettle();

    expect(find.text('Sign in with your manager account'), findsOneWidget);
    expect(find.text('Server address'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Sign in'), findsOneWidget);
  });

  testWidgets('sign-in form asks for the missing fields', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final session = Session();
    await session.restore();
    await tester.pumpWidget(WorkSightApp(session: session));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pump();
    expect(find.text('Enter the address you use for the WorkSight website'), findsOneWidget);
    expect(find.text('Enter your email'), findsOneWidget);
  });
}
