import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import '../widgets/charts.dart';
import '../widgets/common.dart';
import '../widgets/shimmer.dart';
import '../widgets/timeline.dart';
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
    final Widget content;
    if (_error != null && d == null) {
      content = ErrorPanel(message: _error!, onRetry: _load);
    } else if (d == null) {
      content = const _Loading();
    } else {
      final window = timeWindow(d.rows, isToday: d.isToday, now: _now);
      content = Column(
        key: const ValueKey('loaded'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error != null) ...[AlertStrip(text: "Couldn't refresh: $_error"), const SizedBox(height: 12)],
          _Hero(daily: d, now: _now),
          const SizedBox(height: 12),
          _Kpis(daily: d),
          if (window != null && d.summary.present > 0) ...[
            const SizedBox(height: 12),
            _OccupancyCard(daily: d, now: _now, start: window.start, end: window.end),
          ],
          const SectionTitle('Everyone', subtitle: 'Who is in first. Tap a person for their day.'),
          _People(daily: d, now: _now, window: window, onOpen: _open),
          if (_status != null && _status!.channels.isNotEmpty) ...[
            const SectionTitle('Cameras'),
            _CameraStatus(status: _status!, now: _now),
          ],
          const SectionTitle('Recent sightings', subtitle: 'Latest faces recognised by the cameras'),
          _Sightings(events: _events, now: _now),
        ],
      );
    }

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          color: C.accent,
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, kNavClearance),
            children: [
              ScreenHeader(
                title: 'Today',
                subtitle: d == null
                    ? (user.companyName ?? 'Loading…')
                    : '${fmtDate(d.date, pattern: 'EEEE d MMMM')} · updated ${timeAgo(_now, DateTime.now())}',
                trailing: _status == null ? null : _HealthChip(_status!.health, pulseKey: _now),
              ),
              const SizedBox(height: 14),
              if (_status?.health == Health.offline) ...[
                const AlertStrip(
                  tone: Tone.out,
                  text:
                      "Face recognition is offline. The cameras aren't being watched, so arrivals and office time aren't being recorded.",
                ),
                const SizedBox(height: 12),
              ],
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 300),
                switchInCurve: Curves.easeOut,
                child: content,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HealthChip extends StatelessWidget {
  const _HealthChip(this.health, {this.pulseKey});
  final Health health;
  final Object? pulseKey;

  @override
  Widget build(BuildContext context) {
    final (label, fg) = switch (health) {
      Health.live => ('Live', C.greenText),
      Health.degraded => ('Connecting', C.amberText),
      Health.offline => ('Offline', C.roseText),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(99), boxShadow: C.shadow),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        LiveDot(color: healthColor(health), pulseKey: health == Health.live ? pulseKey : null),
        const SizedBox(width: 7),
        Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: fg)),
      ]),
    );
  }
}

// ---------------------------------------------------------------- loading

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    Widget stat() => Expanded(
          child: BoneCard(
            padding: const EdgeInsets.fromLTRB(12, 14, 12, 14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: const [
              Bone(width: 52, height: 10),
              SizedBox(height: 10),
              Bone(width: 44, height: 22),
              SizedBox(height: 10),
              Bone(width: 70, height: 10),
            ]),
          ),
        );
    Widget person(double name, double detail) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          child: Column(children: [
            Row(children: [
              const Bone.circle(40),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Bone(width: name, height: 12),
                  const SizedBox(height: 8),
                  Bone(width: detail, height: 10),
                ]),
              ),
              const Bone(width: 72, height: 24, radius: 99),
            ]),
            const SizedBox(height: 12),
            const Padding(padding: EdgeInsets.only(left: 52), child: Bone(height: 6, radius: 3)),
          ]),
        );

    return Shimmer(
      key: const ValueKey('loading'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        HeroPanel(
          child: Column(children: [
            Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: const [
                  Bone(width: 110, height: 12, onDark: true),
                  SizedBox(height: 14),
                  Bone(width: 90, height: 50, radius: 12, onDark: true),
                  SizedBox(height: 14),
                  Bone(width: 150, height: 12, onDark: true),
                ]),
              ),
              const Bone.circle(104, onDark: true),
            ]),
            const SizedBox(height: 18),
            const Row(children: [
              Bone(width: 112, height: 34, radius: 99, onDark: true),
              SizedBox(width: 12),
              Bone(width: 130, height: 12, onDark: true),
            ]),
          ]),
        ),
        const SizedBox(height: 12),
        IntrinsicHeight(
            child: Row(children: [stat(), const SizedBox(width: 10), stat(), const SizedBox(width: 10), stat()])),
        const SizedBox(height: 12),
        const BoneCard(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Bone(width: 130, height: 14),
            SizedBox(height: 14),
            Bone(height: 100, radius: 12),
          ]),
        ),
        const SectionTitle('Everyone'),
        BoneCard(
          padding: EdgeInsets.zero,
          child: Column(children: [person(130, 190), person(90, 170), person(115, 200)]),
        ),
      ]),
    );
  }
}

// ---------------------------------------------------------------- headline

class _Hero extends StatelessWidget {
  const _Hero({required this.daily, required this.now});
  final DailyReport daily;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final rows = daily.rows;
    final s = daily.summary;
    final inNow = s.inOfficeNow ?? rows.where((r) => r.state == PresenceState.inOffice).length;
    final total = s.employees;
    final notSeen = rows.where((r) => r.state == PresenceState.left && r.lastSeen != null).toList()
      ..sort((a, b) => a.lastSeen!.compareTo(b.lastSeen!));
    final late = rows.where((r) => r.isLate).length;
    final notIn = rows.where((r) => r.state == PresenceState.absent).length;
    final noMotion = MediaQuery.of(context).disableAnimations;

    final parts = [
      if (notSeen.isNotEmpty) '${notSeen.length} not seen now',
      if (late > 0) '$late late today',
      if (notIn > 0) '$notIn not in yet',
    ];
    final ordered = [...rows]..sort((a, b) => presenceOf(a, true).order.compareTo(presenceOf(b, true).order));
    final shown = ordered.take(5).toList();

    final Widget note;
    if (notSeen.isNotEmpty) {
      note = Text.rich(TextSpan(children: [
        TextSpan(text: '${notSeen.first.employee.firstName} not seen for '),
        TextSpan(
            text: fmtDur(now.difference(notSeen.first.lastSeen!).inSeconds),
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
      ]));
    } else if (notIn > 0) {
      note = Text('$notIn not in yet');
    } else if (total > 0) {
      note = const Text('Everyone who came in is in view');
    } else {
      note = const Text('No employees yet');
    }

    return Semantics(
      container: true,
      label: 'In the office now: $inNow of $total',
      child: HeroPanel(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('In the office now',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Color(0xFFA8A29E))),
                const SizedBox(height: 6),
                Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                  TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: inNow.toDouble()),
                    duration: noMotion ? Duration.zero : const Duration(milliseconds: 700),
                    curve: Curves.easeOutCubic,
                    builder: (context, v, _) => Text('${v.round()}',
                        style: const TextStyle(
                            fontSize: 58,
                            height: 1,
                            fontWeight: FontWeight.w800,
                            letterSpacing: -1.5,
                            color: Colors.white,
                            fontFeatures: [FontFeature.tabularFigures()])),
                  ),
                  const SizedBox(width: 6),
                  Text('/ $total',
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: Color(0xFF78716C))),
                ]),
                const SizedBox(height: 10),
                Text(parts.isEmpty ? 'Everyone is in' : parts.join(' · '),
                    style: const TextStyle(fontSize: 13, color: Color(0xFFD6D3D1))),
              ]),
            ),
            ProgressRing(
              value: total > 0 ? inNow / total : 0,
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(total > 0 ? '${(inNow * 100 / total).round()}%' : '—',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Colors.white)),
                const Text('of the team', style: TextStyle(fontSize: 11, color: Color(0xFFA8A29E))),
              ]),
            ),
          ]),
          if (shown.isNotEmpty) ...[
            const SizedBox(height: 16),
            const Divider(color: Color(0xFF292524)),
            const SizedBox(height: 14),
            Row(children: [
              SizedBox(
                width: 34.0 + (shown.length - 1) * 26 + (rows.length > shown.length ? 26 : 0),
                height: 36,
                child: Stack(children: [
                  for (var i = 0; i < shown.length; i++)
                    Positioned(left: i * 26.0, child: _StackedAvatar(row: shown[i])),
                  if (rows.length > shown.length)
                    Positioned(
                      left: shown.length * 26.0,
                      child: Container(
                        width: 34,
                        height: 34,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                            color: const Color(0xFF292524),
                            shape: BoxShape.circle,
                            border: Border.all(color: C.ink, width: 2)),
                        child: Text('+${rows.length - shown.length}',
                            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: Colors.white)),
                      ),
                    ),
                ]),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: DefaultTextStyle.merge(
                  style: const TextStyle(fontSize: 12.5, height: 1.35, color: Color(0xFFD6D3D1)),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  child: note,
                ),
              ),
            ]),
          ],
        ]),
      ),
    );
  }
}

class _StackedAvatar extends StatelessWidget {
  const _StackedAvatar({required this.row});
  final WorkDayRow row;

  @override
  Widget build(BuildContext context) {
    final dot = switch (row.state) {
      PresenceState.inOffice => C.green,
      PresenceState.left => C.accent,
      PresenceState.absent => const Color(0xFF78716C),
    };
    return SizedBox(
      width: 36,
      height: 36,
      child: Stack(children: [
        Container(
          decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: C.ink, width: 2)),
          child: Avatar(name: row.employee.fullName, id: row.employee.id, size: 32),
        ),
        Positioned(
          right: 0,
          bottom: 0,
          child: Container(
            width: 11,
            height: 11,
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle, border: Border.all(color: C.ink, width: 2)),
          ),
        ),
      ]),
    );
  }
}

// ---------------------------------------------------------------- numbers

class _Kpis extends StatelessWidget {
  const _Kpis({required this.daily});
  final DailyReport daily;

  @override
  Widget build(BuildContext context) {
    final rows = daily.rows;
    final s = daily.summary;
    final arrivals = rows.where((r) => r.arrived != null).map((r) => r.arrived!).toList()..sort();
    final late = rows.where((r) => r.isLate).toList()..sort((a, b) => b.lateByMinutes.compareTo(a.lateByMinutes));
    final scheduled = rows.where((r) => (r.scheduledMinutes ?? 0) > 0).map((r) => r.scheduledMinutes!).toList();
    final avgScheduled = scheduled.isEmpty ? 0 : (scheduled.reduce((a, b) => a + b) / scheduled.length).round();

    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: _MiniStat(
            label: 'Arrived',
            value: '${s.present}/${s.employees}',
            sub: arrivals.isEmpty ? 'no one yet' : 'first at ${fmtTime(arrivals.first)}',
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _MiniStat(
            label: 'Late',
            value: '${late.length}',
            valueColor: late.isEmpty ? null : C.accentText,
            sub: late.isEmpty
                ? 'no one'
                : '${late.first.employee.firstName}'
                    '${late.first.lateByMinutes > 0 ? ' · ${fmtMin(late.first.lateByMinutes)}' : ''}'
                    '${late.length > 1 ? ' +${late.length - 1}' : ''}',
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _MiniStat(
            label: 'Avg inside',
            value: s.present > 0 ? fmtMin(s.avgInsideMinutes) : '—',
            sub: s.present == 0
                ? 'no one yet'
                : (avgScheduled > 0 ? 'of a ${fmtMin(avgScheduled)} day' : '${fmtMin(s.totalInsideMinutes)} in all'),
          ),
        ),
      ]),
    );
  }
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.label, required this.value, required this.sub, this.valueColor});
  final String label;
  final String value;
  final String sub;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    return Panel(
      radius: 18,
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: C.muted)),
        const SizedBox(height: 6),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value,
              style: TextStyle(
                  fontSize: 22,
                  height: 1.1,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.4,
                  color: valueColor ?? C.ink,
                  fontFeatures: const [FontFeature.tabularFigures()])),
        ),
        const SizedBox(height: 6),
        Text(sub, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, color: C.muted)),
      ]),
    );
  }
}

class _OccupancyCard extends StatelessWidget {
  const _OccupancyCard({required this.daily, required this.now, required this.start, required this.end});
  final DailyReport daily;
  final DateTime now;
  final DateTime start;
  final DateTime end;

  @override
  Widget build(BuildContext context) {
    final data = Occupancy.of(daily.rows, start: start, end: end, now: now, isToday: daily.isToday);
    final current = data.steps.isEmpty ? 0 : data.steps.last.$2;
    return Panel(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          const Expanded(
            child: Text('Office occupancy', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: C.ink)),
          ),
          Text('peak ${data.peak} · now $current', style: const TextStyle(fontSize: 12, color: C.muted)),
        ]),
        const SizedBox(height: 12),
        OccupancyChart(data: data, start: start, end: end),
        const SizedBox(height: 6),
        TimeAxis(start: start, end: end, maxTicks: 6),
      ]),
    );
  }
}

// ---------------------------------------------------------------- people

class _People extends StatelessWidget {
  const _People({required this.daily, required this.now, required this.window, required this.onOpen});
  final DailyReport daily;
  final DateTime now;
  final ({DateTime start, DateTime end})? window;
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
          if (i > 0) const Divider(indent: 68),
          _PersonRow(row: rows[i], isToday: daily.isToday, now: now, window: window, onTap: () => onOpen(rows[i])),
        ],
      ]),
    );
  }
}

class _PersonRow extends StatelessWidget {
  const _PersonRow(
      {required this.row, required this.isToday, required this.now, required this.window, required this.onTap});
  final WorkDayRow row;
  final bool isToday;
  final DateTime now;
  final ({DateTime start, DateTime end})? window;
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
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        child: Column(children: [
          Row(children: [
            Avatar(name: row.employee.fullName, id: row.employee.id, size: 40),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(row.employee.fullName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: C.ink)),
                const SizedBox(height: 2),
                Text(detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12.5, color: C.muted)),
              ]),
            ),
            const SizedBox(width: 8),
            PresenceBadge(p),
          ]),
          if (window != null && row.wasSeen) ...[
            const SizedBox(height: 10),
            Padding(
              padding: const EdgeInsets.only(left: 52),
              child:
                  TimelineBar(row: row, start: window!.start, end: window!.end, now: now, isToday: isToday, height: 6),
            ),
          ],
        ]),
      ),
    );
  }
}

// ---------------------------------------------------------------- cameras and sightings

class _CameraStatus extends StatelessWidget {
  const _CameraStatus({required this.status, required this.now});
  final RecognitionStatus status;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(children: [
        for (var i = 0; i < status.channels.length; i++) ...[
          if (i > 0) const Divider(indent: 64),
          Builder(builder: (context) {
            final c = status.channels[i];
            final (label, color, fg) = switch (c.state) {
              'running' => ('Live', C.green, C.greenText),
              'error' => ('Error', C.rose, C.roseText),
              _ => ('Connecting', C.accent, C.amberText),
            };
            return ListTile(
              leading: Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(color: C.ink, borderRadius: BorderRadius.circular(12)),
                child: const Icon(Icons.videocam_outlined, size: 20, color: Colors.white),
              ),
              title: Text('${c.cameraName} · lens ${c.channelNo}',
                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: C.ink)),
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
                Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: fg)),
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

  static const _verb = {'CHECK_IN': 'arrived', 'CHECK_OUT': 'was seen', 'SEEN': 'was seen'};

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
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(children: [
        for (var i = 0; i < events.length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(children: [
              Avatar(name: events[i].employeeName, id: events[i].employeeId, size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Text.rich(
                  TextSpan(children: [
                    TextSpan(
                        text: events[i].employeeName,
                        style: const TextStyle(fontWeight: FontWeight.w600, color: C.ink)),
                    TextSpan(text: ' ${_verb[events[i].action] ?? 'was seen'}', style: const TextStyle(color: C.muted)),
                  ]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5),
                ),
              ),
              Text(timeAgo(events[i].seenAt, now), style: const TextStyle(fontSize: 12, color: C.muted)),
            ]),
          ),
      ]),
    );
  }
}
