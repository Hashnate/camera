import 'package:flutter/material.dart';

import '../session.dart';
import '../theme.dart';
import '../widgets/common.dart';

const appVersion = '1.0.0';

/// Account, server, and sign out. Setup (cameras, people, settings) stays on the website.
class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = SessionScope.of(context);
    final user = session.user!;
    final server = session.lastServer ?? '';

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, kNavClearance),
          children: [
            const ScreenHeader(title: 'More'),
            const SizedBox(height: 14),
            Panel(
              child: Row(children: [
                Avatar(name: user.fullName, id: user.id, size: 48),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(user.fullName,
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: C.ink)),
                    Text(user.email, style: const TextStyle(fontSize: 13, color: C.muted)),
                    const SizedBox(height: 4),
                    Text([user.roleLabel, if (user.companyName != null) user.companyName!].join(' · '),
                        style: const TextStyle(fontSize: 12.5, color: C.muted)),
                  ]),
                ),
              ]),
            ),
            const SizedBox(height: 12),
            Panel(
              padding: EdgeInsets.zero,
              child: Column(children: [
                ListTile(
                  leading: const Icon(Icons.dns_outlined),
                  title: const Text('Server'),
                  subtitle: Text(Uri.tryParse(server)?.host ?? server),
                ),
                const Divider(indent: 56),
                const ListTile(
                  leading: Icon(Icons.settings_outlined),
                  title: Text('Setup'),
                  subtitle: Text('Add cameras, employees and users on the WorkSight website.'),
                ),
                const Divider(indent: 56),
                const ListTile(
                  leading: Icon(Icons.info_outline),
                  title: Text('App version'),
                  subtitle: Text(appVersion),
                ),
              ]),
            ),
            const SizedBox(height: 20),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(52),
                backgroundColor: Colors.white,
                foregroundColor: C.roseText,
                side: const BorderSide(color: Color(0xFFFECDD3)),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              ),
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Sign out?'),
                    content: const Text('You can sign in again with your email and password.'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
                      FilledButton(
                        style: FilledButton.styleFrom(minimumSize: const Size(0, 40)),
                        onPressed: () => Navigator.pop(ctx, true),
                        child: const Text('Sign out'),
                      ),
                    ],
                  ),
                );
                if (ok == true) await session.signOut();
              },
              icon: const Icon(Icons.logout),
              label: const Text('Sign out'),
            ),
          ],
        ),
      ),
    );
  }
}
