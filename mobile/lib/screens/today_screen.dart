import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'person_day_screen.dart';

/// Who is in right now and how today is going. Refreshes every 30 seconds while it's on screen.
class TodayScreen extends StatefulWidget {
  const TodayScreen({super.key, required this.active});

  /// The tab is showing (no refreshing in the background).
  final bool active;

  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> with WidgetsBindingObserver {
  DailyReport? _daily;
  RecognitionStatus? _status;
  List<RecognitionEvent> _events = const [];
  String? _error;
  DateTime _now = DateTime.now();
  Timer? _timer;
  bool _foreground = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (widget.active && _foreground) _load();
    });
  }

  @override
  void didUpdateWidget(TodayScreen old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) _load();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground && widget.active) _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final api = SessionScope.read(context).api;
    final statusF = api.recognitionStatus();
    final eventsF = api.recentSightings();
    try {
      final daily = await api.daily();
      final status = await statusF;
      final events = await eventsF;
      if (!mounted) return;
      setState(() {
        _daily = daily;
        _status = status;
        _events = events;
        _error = null;
        _now = DateTime.now();
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _open(WorkDayRow r) => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => PersonDayScreen(employeeId: r.employee.id, name: r.employee.fullName),
      ));

  @override
  Widget build(BuildContext context) {
    final user = SessionScope.of(context).user!;
    final d = _daily;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Today'),
            Text(
              d == null
                  ? (user.companyName ?? 'Loading…')
                  : '${fmtDate(d.date, pattern: 'EEEE d MMMM')} · updated ${timeAgo(_now, DateTime.now())}',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w400, color: C.muted),
            ),
          ],
        ),
        actions: [
          if (_status != null) Padding(padding: const EdgeInsets.only(right: 12), child: _HealthChip(_status!.health))
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          children: [
            if (_status?.health == Health.offline) ...[
              const AlertStrip(
                tone: Tone.out,
                text:
                    "Face recognition is offline. The cameras aren't being watched, so arrivals and office time aren't being recorded.",
              ),
              const SizedBox(height: 12),
            ],
            if (_error != null && d == null)
              ErrorPanel(message: _error!, onRetry: _load)
            else if (d == null)
              const _Loading()
            else ...[
              if (_error != null) ...[AlertStrip(text: "Couldn't refresh: $_error"), const SizedBox(height: 12)],
              _Kpis(daily: d, now: _now),
              const SizedBox(height: 8),
              SectionTitle('Everyone', subtitle: 'Ordered by who is in. Tap a person for their day.'),
              _People(daily: d, now: _now, onOpen: _open),
              const SizedBox(height: 8),
              if (_status != null && _status!.channels.isNotEmpty) ...[
                const SectionTitle('Cameras'),
                _CameraStatus(status: _status!, now: _now),
                const SizedBox(height: 8),
              ],
              const SectionTitle('Recent sightings', subtitle: 'Latest faces recognised by the cameras'),
              _Sightings(events: _events, now: _now),
            ],
          ],
        ),
      ),
    );
  }
}

class _HealthChip extends StatelessWidget {
  const _HealthChip(this.health);
  final Health health;

  @override
  Widget build(BuildContext context) {
    final color = healthColor(health);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
          color: Colors.white, borderRadius: BorderRadius.circular(99), border: Border.all(color: C.line)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 6),
        Text(switch (health) { Health.live => 'Live', Health.degraded => 'Connecting', Health.offline => 'Offline' },
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: C.text)),
      ]),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    return const Column(children: [
      TileGrid(children: [Skeleton(height: 96), Skeleton(height: 96), Skeleton(height: 96), Skeleton(height: 96)]),
      SizedBox(height: 20),
      Skeleton(height: 64),
      SizedBox(height: 10),
      Skeleton(height: 64),
      SizedBox(height: 10),
      Skeleton(height: 64),
    ]);
  }
}

class _Kpis extends StatelessWidget {
  const _Kpis({required this.daily, required this.now});
  final DailyReport daily;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final rows = daily.rows;
    final s = daily.summary;
    final inNow = s.inOfficeNow ?? rows.where((r) => r.state == PresenceState.inOffice).length;
    final notSeen = rows.where((r) => r.state == PresenceState.left && r.lastSeen != null).toList()
      ..sort((a, b) => a.lastSeen!.compareTo(b.lastSeen!));
    final late = rows.where((r) => r.isLate).length;
    final notIn = rows.where((r) => r.state == PresenceState.absent).length;

    return TileGrid(children: [
      StatTile(
        label: 'In the office now',
        icon: Icons.how_to_reg_outlined,
        value: '$inNow',
        sub: Text('of ${s.employees} · $notIn not in yet'),
      ),
      StatTile(
        label: 'Not seen now',
        icon: Icons.visibility_off_outlined,
        value: '${notSeen.length}',
        valueColor: notSeen.isEmpty ? null : C.amberText,
        sub: Text(notSeen.isEmpty
            ? 'Everyone who came in is in view'
            : '${notSeen.first.employee.firstName} for ${fmtDur(now.difference(notSeen.first.lastSeen!).inSeconds)}${notSeen.length > 1 ? ' · +${notSeen.length - 1}' : ''}'),
      ),
      StatTile(
        label: 'Arrived today',
        icon: Icons.login,
        value: '${s.present}',
        sub: late > 0
            ? Text('of ${s.employees} · $late late',
                style: const TextStyle(color: C.roseText, fontWeight: FontWeight.w500))
            : Text('of ${s.employees} · no late arrivals'),
      ),
      StatTile(
        label: 'Average time inside',
        icon: Icons.timer_outlined,
        value: s.present > 0 ? fmtMin(s.avgInsideMinutes) : '—',
        sub: Text(s.present > 0 ? '${fmtMin(s.totalInsideMinutes)} in total' : 'No one has come in yet'),
      ),
    ]);
  }
}

class _People extends StatelessWidget {
  const _People({required this.daily, required this.now, required this.onOpen});
  final DailyReport daily;
  final DateTime now;
  final void Function(WorkDayRow) onOpen;

  @override
  Widget build(BuildContext context) {
    if (daily.rows.isEmpty) {
      return const Panel(
          child: EmptyState(
              icon: Icons.groups_outlined, title: 'No employees yet', message: 'Add your team on the website.'));
    }
    final rows = [...daily.rows]..sort((a, b) {
        final pa = presenceOf(a, daily.isToday).order;
        final pb = presenceOf(b, daily.isToday).order;
        return pa != pb ? pa.compareTo(pb) : a.employee.fullName.compareTo(b.employee.fullName);
      });
    return Panel(
      padding: EdgeInsets.zero,
      child: Column(children: [
        for (var i = 0; i < rows.length; i++) ...[
          if (i > 0) const Divider(indent: 64),
          _PersonRow(row: rows[i], isToday: daily.isToday, now: now, onTap: () => onOpen(rows[i])),
        ],
      ]),
    );
  }
}

class _PersonRow extends StatelessWidget {
  const _PersonRow({required this.row, required this.isToday, required this.now, required this.onTap});
  final WorkDayRow row;
  final bool isToday;
  final DateTime now;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = presenceOf(row, isToday);
    final detail = row.wasSeen
        ? 'Arrived ${fmtTime(row.arrived)} · inside ${fmtDur(row.insideSeconds)}${row.isLate ? ' · late' : ''}'
        : (presenceDetail(row, isToday, now) ?? 'Not seen today');
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(children: [
          Avatar(name: row.employee.fullName, id: row.employee.id),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(row.employee.fullName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w500, color: C.ink)),
              const SizedBox(height: 2),
              Text(detail,
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: C.muted)),
            ]),
          ),
          const SizedBox(width: 8),
          PresenceBadge(p),
        ]),
      ),
    );
  }
}

class _CameraStatus extends StatelessWidget {
  const _CameraStatus({required this.status, required this.now});
  final RecognitionStatus status;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: EdgeInsets.zero,
      child: Column(children: [
        for (var i = 0; i < status.channels.length; i++) ...[
          if (i > 0) const Divider(indent: 56),
          Builder(builder: (context) {
            final c = status.channels[i];
            final (label, color) = switch (c.state) {
              'running' => ('Live', C.green),
              'error' => ('Error', C.rose),
              _ => ('Connecting', C.amber),
            };
            return ListTile(
              leading: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(color: C.track, borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.videocam_outlined, size: 20, color: C.muted),
              ),
              title: Text('${c.cameraName} · lens ${c.channelNo}',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
              subtitle: Text(
                c.state == 'error' && c.lastError != null
                    ? c.lastError!
                    : (c.lastFrameAt != null ? 'Last frame ${timeAgo(c.lastFrameAt, now)}' : 'No picture yet'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, color: C.muted),
              ),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
                const SizedBox(width: 6),
                Text(label, style: const TextStyle(fontSize: 12.5, color: C.text)),
              ]),
            );
          }),
        ],
      ]),
    );
  }
}

class _Sightings extends StatelessWidget {
  const _Sightings({required this.events, required this.now});
  final List<RecognitionEvent> events;
  final DateTime now;

  static const _verb = {'CHECK_IN': 'arrived', 'CHECK_OUT': 'left', 'SEEN': 'was seen'};

  @override
  Widget build(BuildContext context) {
    if (events.isEmpty) {
      return const Panel(
          child: EmptyState(
              icon: Icons.face_outlined,
              title: 'No sightings yet',
              message: 'Recognised faces appear here as people pass the cameras.'));
    }
    return Panel(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(children: [
        for (final e in events)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            child: Row(children: [
              Avatar(name: e.employeeName, id: e.employeeId, size: 30),
              const SizedBox(width: 10),
              Expanded(
                child: Text.rich(
                  TextSpan(children: [
                    TextSpan(text: e.employeeName, style: const TextStyle(fontWeight: FontWeight.w500, color: C.ink)),
                    TextSpan(text: ' ${_verb[e.action] ?? 'was seen'}', style: const TextStyle(color: C.muted)),
                  ]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5),
                ),
              ),
              Text(timeAgo(e.seenAt, now), style: const TextStyle(fontSize: 12, color: C.muted)),
            ]),
          ),
      ]),
    );
  }
}
