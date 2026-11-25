import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/shimmer.dart';
import '../widgets/timeline.dart';

/// One person's day: timeline, arrival, time inside and away, and every face sighting.
class PersonDayScreen extends StatefulWidget {
  const PersonDayScreen({super.key, required this.employeeId, required this.name, this.date});
  final String employeeId;
  final String name;

  /// Null = today.
  final String? date;

  @override
  State<PersonDayScreen> createState() => _PersonDayScreenState();
}

class _PersonDayScreenState extends State<PersonDayScreen> {
  String? _date;
  DailyReport? _daily;
  List<Sighting>? _sightings;
  String? _error;
  bool _loading = true;
  DateTime _now = DateTime.now();
  Timer? _timer;
  int _requestId = 0;

  @override
  void initState() {
    super.initState();
    _date = widget.date;
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (_daily?.isToday ?? false) _load(quiet: true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    final id = ++_requestId;
    if (!quiet && !_loading) setState(() => _loading = true);
    final api = SessionScope.read(context).api;
    try {
      final daily = await api.daily(date: _date);
      List<Sighting>? sightings;
      try {
        sightings = await api.sightings(widget.employeeId, daily.date);
      } on ApiException {
        sightings = null;
      }
      if (!mounted || id != _requestId) return;
      setState(() {
        _daily = daily;
        _sightings = sightings;
        _error = null;
        _now = DateTime.now();
      });
    } on ApiException catch (e) {
      if (mounted && id == _requestId) setState(() => _error = e.message);
    } finally {
      if (mounted && id == _requestId) setState(() => _loading = false);
    }
  }

  void _goTo(String? date) {
    setState(() {
      _date = (date != null && date == _daily?.today) ? null : date;
      _sightings = null;
    });
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final d = _daily;
    final row = d?.rowFor(widget.employeeId);
    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(row?.employee.fullName ?? widget.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          Text(
            d == null ? 'Office time' : (d.isToday ? 'Today' : fmtDate(d.date, pattern: 'EEEE d MMMM')),
            style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w400, color: C.muted),
          ),
        ]),
        actions: [
          IconButton(
              tooltip: 'Previous day',
              onPressed: d == null ? null : () => _goTo(shiftDate(d.date, -1)),
              icon: const Icon(Icons.chevron_left)),
          IconButton(
            tooltip: 'Next day',
            onPressed: (d == null || d.isToday) ? null : () => _goTo(shiftDate(d.date, 1)),
            icon: const Icon(Icons.chevron_right),
          ),
          const SizedBox(width: 4),
        ],
        bottom: _loading
            ? const PreferredSize(preferredSize: Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2))
            : null,
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          children: [
            if (_error != null && d == null)
              ErrorPanel(message: _error!, onRetry: _load)
            else if (d == null)
              const Shimmer(
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  BoneCard(
                    child: Row(children: [
                      Bone.circle(48),
                      SizedBox(width: 14),
                      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Bone(width: 150, height: 14),
                        SizedBox(height: 8),
                        Bone(width: 110, height: 10),
                      ]),
                    ]),
                  ),
                  SizedBox(height: 12),
                  BoneCard(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Bone(width: 120, height: 14),
                      SizedBox(height: 14),
                      Bone(height: 26, radius: 8),
                      SizedBox(height: 10),
                      Bone(height: 10, radius: 5),
                    ]),
                  ),
                  SizedBox(height: 12),
                  Row(children: [
                    Expanded(child: BoneCard(child: Bone(height: 54, radius: 8))),
                    SizedBox(width: 10),
                    Expanded(child: BoneCard(child: Bone(height: 54, radius: 8))),
                  ]),
                  SizedBox(height: 12),
                  BoneCard(child: Bone(height: 120, radius: 10)),
                ]),
              )
            else if (row == null)
              const Panel(
                child: EmptyState(
                  icon: Icons.person_off_outlined,
                  title: 'Employee not found',
                  message: 'They may have been removed or deactivated. Only active employees have office time.',
                ),
              )
            else
              ..._content(d, row),
          ],
        ),
      ),
    );
  }

  List<Widget> _content(DailyReport d, WorkDayRow row) {
    final p = presenceOf(row, d.isToday);
    final detail = presenceDetail(row, d.isToday, _now);
    final e = row.employee;
    final win = timeWindow([row], isToday: d.isToday, now: _now);
    final pct = row.percentOfSchedule;

    return [
      Panel(
        child: Row(children: [
          Avatar(name: e.fullName, id: e.id, size: 48),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(
                  [e.employeeCode, if (e.jobTitle != null) e.jobTitle!, if (e.department != null) e.department!]
                      .join(' · '),
                  style: const TextStyle(fontSize: 12.5, color: C.muted)),
              const SizedBox(height: 6),
              Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                PresenceBadge(p),
                if (detail != null) Text(detail, style: const TextStyle(fontSize: 12, color: C.muted)),
              ]),
              if (row.schedule != null) ...[
                const SizedBox(height: 6),
                Text('Work hours ${row.schedule!.start}–${row.schedule!.end} · ${row.schedule!.graceMinutes} min grace',
                    style: const TextStyle(fontSize: 12, color: C.muted)),
              ],
            ]),
          ),
        ]),
      ),
      const SizedBox(height: 12),
      if (!row.wasSeen)
        Panel(
          child: EmptyState(
            icon: Icons.event_busy_outlined,
            title: d.isToday ? 'Not in yet today' : 'Not seen on this day',
            message: d.isToday && row.schedule != null
                ? 'Work starts at ${fmtTime(row.schedule!.startAt)}. Their day appears here as soon as a camera recognises them.'
                : 'No camera recognised them on this day.',
          ),
        )
      else ...[
        // Day at a glance
        Panel(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Day at a glance', style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: C.ink)),
            const SizedBox(height: 12),
            if (win != null) ...[
              TimeAxis(start: win.start, end: win.end),
              const SizedBox(height: 4),
              TimelineBar(row: row, start: win.start, end: win.end, now: _now, isToday: d.isToday, height: 26),
              const SizedBox(height: 10),
              TimelineLegend(isToday: d.isToday),
            ],
          ]),
        ),
        const SizedBox(height: 12),
        TileGrid(children: [
          StatTile(
            label: 'Arrived',
            value: fmtTime(row.arrived),
            valueColor: row.isLate ? C.accentText : null,
            sub: Text(row.isLate
                ? 'Late by ${fmtMin(row.lateByMinutes)}'
                : row.schedule != null
                    ? 'On time (${row.schedule!.start})'
                    : 'On time'),
          ),
          StatTile(
            label: d.isToday && row.state == PresenceState.inOffice ? 'Last seen' : 'Left / last seen',
            value: fmtTime(row.lastSeen),
            sub: Text('${fmtMin(row.spanMinutes)} after arriving'),
          ),
          StatTile(
            label: 'Inside',
            value: fmtDur(row.insideSeconds),
            sub: pct != null ? Text('$pct% of ${fmtMin(row.scheduledMinutes!)}') : null,
          ),
          StatTile(
            label: 'Away',
            value: row.awayPeriods.isEmpty ? 'None' : fmtDur(row.awaySeconds),
            valueColor: row.awayPeriods.isEmpty ? null : C.amberText,
            sub: row.awayPeriods.isEmpty
                ? null
                : Text('${row.awayPeriods.length}× · longest ${fmtDur(row.longestAwaySeconds)}'),
          ),
        ]),
        const SizedBox(height: 8),
        SectionTitle('Away periods', subtitle: 'Not seen by any camera for over ${d.awayAfterMinutes} min'),
        Panel(
          padding: EdgeInsets.zero,
          child: row.awayPeriods.isEmpty
              ? const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('No away periods: seen continuously since arriving.',
                      style: TextStyle(fontSize: 13, color: C.muted)),
                )
              : Column(children: [
                  for (var i = 0; i < row.awayPeriods.length; i++) ...[
                    if (i > 0) const Divider(),
                    _AwayRow(span: row.awayPeriods[i]),
                  ],
                ]),
        ),
        const SizedBox(height: 8),
        SectionTitle('Face sightings', subtitle: '${row.sightings} on this day · newest first'),
        _SightingsList(sightings: _sightings, awayAfterMinutes: d.awayAfterMinutes),
      ],
    ];
  }
}

class _AwayRow extends StatelessWidget {
  const _AwayRow({required this.span});
  final Span span;

  @override
  Widget build(BuildContext context) {
    final long = span.seconds >= 15 * 60;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
      child: Row(children: [
        Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: long ? C.amber : C.amberLight, shape: BoxShape.circle)),
        const SizedBox(width: 10),
        Expanded(
            child: Text('${fmtTime(span.start)} → ${fmtTime(span.end)}',
                style: const TextStyle(fontSize: 13.5, color: C.text))),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(color: long ? C.amberSoft : C.track, borderRadius: BorderRadius.circular(99)),
          child: Text(fmtDur(span.seconds),
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: long ? C.amberText : C.muted)),
        ),
      ]),
    );
  }
}

class _SightingsList extends StatelessWidget {
  const _SightingsList({required this.sightings, required this.awayAfterMinutes});
  final List<Sighting>? sightings;
  final int awayAfterMinutes;

  @override
  Widget build(BuildContext context) {
    final list = sightings;
    if (list == null) return const Skeleton(height: 120);
    if (list.isEmpty) {
      return const Panel(child: Text('No face sightings on this day.', style: TextStyle(fontSize: 13, color: C.muted)));
    }
    final newest = list.reversed.toList();
    final items = <Widget>[];
    for (var i = 0; i < newest.length; i++) {
      final s = newest[i];
      items.add(Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Row(children: [
          SizedBox(
              width: 96,
              child: Text(fmtTime(s.seenAt, seconds: true), style: const TextStyle(fontSize: 13, color: C.text))),
          if (s.arrived)
            Container(
              margin: const EdgeInsets.only(right: 8),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              decoration: BoxDecoration(color: C.greenSoft, borderRadius: BorderRadius.circular(6)),
              child: const Text('ARRIVED',
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: C.greenText)),
            ),
          Expanded(child: Text('Lens ${s.channelNo}', style: const TextStyle(fontSize: 12.5, color: C.muted))),
          Text('${(s.similarity * 100).round()}%',
              style: TextStyle(fontSize: 12.5, color: s.similarity >= 0.6 ? C.greenText : C.muted)),
        ]),
      ));
      if (i + 1 < newest.length) {
        final gap = s.seenAt.difference(newest[i + 1].seenAt).inSeconds;
        if (gap > awayAfterMinutes * 60) {
          items.add(Container(
            width: double.infinity,
            color: C.amberSoft,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
            child: Text('No face for ${fmtDur(gap)}', style: const TextStyle(fontSize: 12, color: C.amberText)),
          ));
        }
      }
    }
    return Panel(padding: const EdgeInsets.symmetric(vertical: 6), child: Column(children: items));
  }
}
