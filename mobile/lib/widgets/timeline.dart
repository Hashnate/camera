import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../api/models.dart';
import '../theme.dart';

const _hour = Duration(hours: 1);

/// Window covering the schedule, every sighting and "now" (today), snapped to whole hours.
({DateTime start, DateTime end})? timeWindow(List<WorkDayRow> rows, {required bool isToday, required DateTime now}) {
  final pts = <DateTime>[];
  for (final r in rows) {
    if (r.sessions.isNotEmpty) {
      pts.addAll([r.sessions.first.start, r.sessions.last.end]);
    }
    if (r.schedule != null && (r.sessions.isNotEmpty || !isToday)) {
      pts.addAll([r.schedule!.startAt, r.schedule!.endAt]);
    }
  }
  if (pts.isEmpty) return null;
  var start = pts.reduce((a, b) => a.isBefore(b) ? a : b);
  var end = pts.reduce((a, b) => a.isAfter(b) ? a : b);
  if (isToday && now.isAfter(end)) end = now;
  start = DateTime(start.year, start.month, start.day, start.hour);
  final endFloor = DateTime(end.year, end.month, end.day, end.hour);
  end = endFloor == end ? end : endFloor.add(_hour);
  if (!end.isAfter(start)) end = start.add(_hour);
  return (start: start, end: end);
}

/// Hour labels above a timeline.
class TimeAxis extends StatelessWidget {
  const TimeAxis({super.key, required this.start, required this.end, this.maxTicks = 5});
  final DateTime start;
  final DateTime end;
  final int maxTicks;

  @override
  Widget build(BuildContext context) {
    final span = end.difference(start).inMinutes;
    final hours = (span / 60).round();
    final step = math.max(1, (hours / (maxTicks - 1)).ceil());
    final ticks = <DateTime>[];
    for (var t = start; !t.isAfter(end); t = t.add(Duration(hours: step))) {
      ticks.add(t);
    }
    final fmt = DateFormat('h a');
    return SizedBox(
      height: 16,
      child: Stack(
        children: [
          for (final t in ticks)
            Align(
              alignment: Alignment(-1 + 2 * (t.difference(start).inMinutes / math.max(1, span)), 0),
              child: Text(fmt.format(t), style: const TextStyle(fontSize: 10.5, color: C.subtle)),
            ),
        ],
      ),
    );
  }
}

/// One person's day: work hours pale grey, inside green, away orange, "not seen since" pale orange, an orange "now"
/// line.
class TimelineBar extends StatelessWidget {
  const TimelineBar(
      {super.key,
      required this.row,
      required this.start,
      required this.end,
      required this.now,
      required this.isToday,
      this.height = 14});
  final WorkDayRow row;
  final DateTime start;
  final DateTime end;
  final DateTime now;
  final bool isToday;
  final double height;

  @override
  Widget build(BuildContext context) {
    final spanMs = math.max(1, end.difference(start).inMilliseconds);
    final lastEnd = row.sessions.isEmpty ? null : row.sessions.last.end;
    final notSeenTail = isToday && row.state == PresenceState.left && lastEnd != null && now.isAfter(lastEnd);

    return LayoutBuilder(builder: (context, c) {
      final w = c.maxWidth;
      double x(DateTime t) => (t.difference(start).inMilliseconds / spanMs).clamp(0.0, 1.0) * w;
      Widget seg(DateTime a, DateTime b, Color color, {double radius = 3}) {
        final l = x(a);
        final width = math.max(2.0, x(b) - l);
        return Positioned(
          left: l,
          width: width,
          top: 0,
          bottom: 0,
          child: DecoratedBox(decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(radius))),
        );
      }

      return SizedBox(
        height: height,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: Stack(
            children: [
              const Positioned.fill(child: ColoredBox(color: C.track)),
              if (row.schedule != null) seg(row.schedule!.startAt, row.schedule!.endAt, C.line, radius: 6),
              for (final p in row.awayPeriods) seg(p.start, p.end, p.seconds >= 15 * 60 ? C.accent : C.amberLight),
              if (notSeenTail) seg(lastEnd, now, C.amberSoft),
              for (final s in row.sessions) seg(s.start, s.end, C.inside),
              if (isToday && now.isAfter(start) && now.isBefore(end))
                Positioned(left: x(now) - 1, width: 2, top: 0, bottom: 0, child: const ColoredBox(color: C.accent)),
            ],
          ),
        ),
      );
    });
  }
}

class TimelineLegend extends StatelessWidget {
  const TimelineLegend({super.key, required this.isToday});
  final bool isToday;

  @override
  Widget build(BuildContext context) {
    Widget item(Color c, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 12, height: 9, decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(2))),
          const SizedBox(width: 5),
          Text(label, style: const TextStyle(fontSize: 11.5, color: C.muted)),
        ]);
    return Wrap(spacing: 14, runSpacing: 6, children: [
      item(C.inside, 'Inside'),
      item(C.accent, 'Away'),
      if (isToday) item(C.amberSoft, 'Not seen since'),
      item(C.line, 'Work hours'),
    ]);
  }
}
