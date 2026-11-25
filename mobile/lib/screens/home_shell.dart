import 'package:flutter/material.dart';

import '../session.dart';
import '../theme.dart';
import 'cameras_screen.dart';
import 'more_screen.dart';
import 'office_time_screen.dart';
import 'today_screen.dart';

typedef _Tab = ({Widget screen, IconData icon, IconData selectedIcon, String label});

/// Floating tab bar. Each tab keeps its place when you switch away and back.
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
    final tabs = <_Tab>[
      (
        screen: TodayScreen(active: _index == 0),
        icon: Icons.calendar_today_outlined,
        selectedIcon: Icons.calendar_today,
        label: 'Today'
      ),
      (
        screen: OfficeTimeScreen(active: _index == 1),
        icon: Icons.schedule_outlined,
        selectedIcon: Icons.schedule,
        label: 'Office time'
      ),
      if (user.can('cameras.live'))
        (
          screen: CamerasScreen(active: _index == 2),
          icon: Icons.videocam_outlined,
          selectedIcon: Icons.videocam,
          label: 'Cameras'
        ),
      (screen: const MoreScreen(), icon: Icons.menu, selectedIcon: Icons.menu_open, label: 'More'),
    ];
    final index = _index.clamp(0, tabs.length - 1);

    return Scaffold(
      extendBody: true,
      // Hidden tabs stay built (they keep their place) but don't animate: no shimmer or ripples off screen.
      body: IndexedStack(index: index, children: [
        for (var i = 0; i < tabs.length; i++) TickerMode(enabled: i == index, child: tabs[i].screen),
      ]),
      bottomNavigationBar: SafeArea(
        top: false,
        minimum: const EdgeInsets.fromLTRB(16, 0, 16, 14),
        child: Container(
          height: 68,
          decoration: BoxDecoration(
            color: C.ink,
            borderRadius: BorderRadius.circular(24),
            boxShadow: const [BoxShadow(color: Color(0x2E000000), blurRadius: 30, offset: Offset(0, 10))],
          ),
          child: Row(children: [
            for (var i = 0; i < tabs.length; i++)
              Expanded(
                child: _NavItem(tab: tabs[i], selected: i == index, onTap: () => setState(() => _index = i)),
              ),
          ]),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({required this.tab, required this.selected, required this.onTap});
  final _Tab tab;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    const idle = Color(0xFFA8A29E);
    return Semantics(
      button: true,
      selected: selected,
      child: InkResponse(
        onTap: onTap,
        radius: 36,
        highlightColor: Colors.transparent,
        splashColor: Colors.white24,
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 180),
            child: Icon(selected ? tab.selectedIcon : tab.icon,
                key: ValueKey(selected), size: 23, color: selected ? C.accent : idle),
          ),
          const SizedBox(height: 4),
          Text(
            tab.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
                fontSize: 11,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                color: selected ? Colors.white : idle),
          ),
        ]),
      ),
    );
  }
}
