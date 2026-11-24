import 'package:flutter/material.dart';

import '../session.dart';
import 'cameras_screen.dart';
import 'more_screen.dart';
import 'office_time_screen.dart';
import 'today_screen.dart';

/// Bottom tabs. Each tab keeps its place when you switch away and back.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final user = SessionScope.of(context).user!;
    final tabs = <({Widget screen, NavigationDestination dest})>[
      (
        screen: TodayScreen(active: _index == 0),
        dest: const NavigationDestination(
            icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today), label: 'Today'),
      ),
      (
        screen: OfficeTimeScreen(active: _index == 1),
        dest: const NavigationDestination(
            icon: Icon(Icons.schedule_outlined), selectedIcon: Icon(Icons.schedule), label: 'Office time'),
      ),
      if (user.can('cameras.live'))
        (
          screen: CamerasScreen(active: _index == 2),
          dest: const NavigationDestination(
              icon: Icon(Icons.videocam_outlined), selectedIcon: Icon(Icons.videocam), label: 'Cameras'),
        ),
      (
        screen: const MoreScreen(),
        dest: const NavigationDestination(icon: Icon(Icons.menu), selectedIcon: Icon(Icons.menu_open), label: 'More'),
      ),
    ];
    final index = _index.clamp(0, tabs.length - 1);

    return Scaffold(
      body: IndexedStack(index: index, children: [for (final t in tabs) t.screen]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [for (final t in tabs) t.dest],
      ),
    );
  }
}
