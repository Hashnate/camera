import 'package:flutter/material.dart';

import 'screens/home_shell.dart';
import 'screens/login_screen.dart';
import 'session.dart';
import 'theme.dart';
import 'widgets/common.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final session = Session()..restore();
  runApp(WorkSightApp(session: session));
}

class WorkSightApp extends StatelessWidget {
  const WorkSightApp({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    return SessionScope(
      session: session,
      child: MaterialApp(
        title: 'WorkSight',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        home: const _Root(),
      ),
    );
  }
}

/// Splash while the saved sign-in is checked, then the app or the sign-in screen.
class _Root extends StatelessWidget {
  const _Root();

  @override
  Widget build(BuildContext context) {
    final session = SessionScope.of(context);
    if (session.restoring) return const _Splash();
    if (session.signedIn) return const HomeShell();
    if (session.restoreError != null) {
      return _Offline(message: session.restoreError!);
    }
    return const LoginScreen();
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            BrandMark(size: 56),
            SizedBox(height: 24),
            SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4)),
          ],
        ),
      ),
    );
  }
}

/// A saved sign-in exists but the server can't be reached right now.
class _Offline extends StatelessWidget {
  const _Offline({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    final session = SessionScope.read(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: EmptyState(
              icon: Icons.cloud_off_outlined,
              title: "Can't reach ${Uri.tryParse(session.lastServer ?? '')?.host ?? 'the server'}",
              message: message,
              action: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  FilledButton.icon(
                      onPressed: session.restore, icon: const Icon(Icons.refresh), label: const Text('Try again')),
                  const SizedBox(height: 8),
                  TextButton(
                      onPressed: () => session.signOut(notice: ''), child: const Text('Sign in to another server')),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
