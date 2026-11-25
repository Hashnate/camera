import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme.dart';

/// Circular progress (0..1) with anything in the middle.
class ProgressRing extends StatelessWidget {
  const ProgressRing({
    super.key,
    required this.value,
    this.size = 104,
    this.stroke = 11,
    this.color = C.accent,
    this.track = const Color(0xFF292524),
    this.child,
  });
  final double value;
  final double size;
  final double stroke;
  final Color color;
  final Color track;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final v = value.isFinite ? value.clamp(0.0, 1.0) : 0.0;
    return SizedBox(
      width: size,
      height: size,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: v),
        duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 900),
        curve: Curves.easeOutCubic,
        builder: (context, t, child) => CustomPaint(
          painter: _RingPainter(t, stroke, color, track),
          child: Center(child: child),
        ),
        child: child,
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.value, this.stroke, this.color, this.track);
  final double value;
  final double stroke;
  final Color color;
  final Color track;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final r = rect.deflate(stroke / 2);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(r, 0, math.pi * 2, false, p..color = track);
    if (value > 0) canvas.drawArc(r, -math.pi / 2, math.pi * 2 * value, false, p..color = color);
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.value != value || old.color != color || old.track != track || old.stroke != stroke;
}

/// How many people were inside over the day: one step each time someone came in or went out.
class Occupancy {
  const Occupancy(this.steps, this.peak, this.until);

  /// (time, people inside from then on), in time order, starting at the window start.
  final List<(DateTime, int)> steps;
  final int peak;

  /// The line stops here (now for today, the window end for a past day).
  final DateTime until;

  static Occupancy of(List<WorkDayRow> rows,
      {required DateTime start, required DateTime end, required DateTime now, required bool isToday}) {
    final until = isToday && now.isBefore(end) ? now : end;
    final changes = <(DateTime, int)>[];
    for (final r in rows) {
      for (var i = 0; i < r.sessions.length; i++) {
        final s = r.sessions[i];
        // Someone in the office now is inside until now, not just until their last sighting.
        final stillIn = isToday && r.state == PresenceState.inOffice && i == r.sessions.length - 1;
        final e = stillIn && now.isAfter(s.end) ? now : s.end;
        if (!e.isAfter(s.start)) continue;
        changes.add((s.start, 1));
        changes.add((e, -1));
      }
    }
    changes.sort((a, b) {
      final c = a.$1.compareTo(b.$1);
      return c != 0 ? c : a.$2.compareTo(b.$2); // leaving before arriving at the same moment
    });
    var count = 0;
    var peak = 0;
    final steps = <(DateTime, int)>[(start, 0)];
    for (final (t, d) in changes) {
      // Only what happened before the line's end: people still in are "inside until now", which must not show as
      // everyone leaving at now.
      if (!t.isBefore(until)) break;
      count += d;
      peak = math.max(peak, count);
      if (!t.isAfter(start)) {
        steps[0] = (start, count);
      } else if (steps.last.$1 == t) {
        steps[steps.length - 1] = (t, count);
      } else {
        steps.add((t, count));
      }
    }
    return Occupancy(steps, math.max(peak, steps.first.$2), until);
  }
}

/// Step chart of [Occupancy]: orange line and soft fill, a dashed "now" line.
class OccupancyChart extends StatelessWidget {
  const OccupancyChart(
      {super.key, required this.data, required this.start, required this.end, this.height = 100, this.showNow = true});
  final Occupancy data;
  final DateTime start;
  final DateTime end;
  final double height;
  final bool showNow;

  @override
  Widget build(BuildContext context) {
    final last = data.steps.isEmpty ? 0 : data.steps.last.$2;
    return Semantics(
      label: 'People inside through the day: at most ${data.peak}, $last at the end of the line',
      child: SizedBox(
        height: height,
        width: double.infinity,
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: 1),
          duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 900),
          curve: Curves.easeOutCubic,
          builder: (context, t, _) => CustomPaint(painter: _OccupancyPainter(data, start, end, t, showNow)),
        ),
      ),
    );
  }
}

class _OccupancyPainter extends CustomPainter {
  _OccupancyPainter(this.data, this.start, this.end, this.reveal, this.showNow);
  final Occupancy data;
  final DateTime start;
  final DateTime end;
  final double reveal; // 0..1: the line draws in from the left
  final bool showNow;

  @override
  void paint(Canvas canvas, Size size) {
    const top = 8.0, bottom = 4.0;
    final h = size.height - top - bottom;
    final span = math.max(1, end.difference(start).inMilliseconds);
    final maxY = math.max(1, data.peak);
    double x(DateTime t) => (t.difference(start).inMilliseconds / span).clamp(0.0, 1.0) * size.width;
    double y(int c) => top + h - (c / maxY) * h;

    final grid = Paint()
      ..color = C.track
      ..strokeWidth = 1;
    for (final level in {0, maxY ~/ 2, maxY}) {
      canvas.drawLine(Offset(0, y(level)), Offset(size.width, y(level)), grid);
    }
    if (data.steps.isEmpty) return;

    final endX = x(data.until) * reveal;
    final line = Path()..moveTo(0, y(data.steps.first.$2));
    for (var i = 1; i < data.steps.length; i++) {
      final sx = x(data.steps[i].$1);
      if (sx > endX) break;
      line
        ..lineTo(sx, y(data.steps[i - 1].$2))
        ..lineTo(sx, y(data.steps[i].$2));
    }
    final lastBefore = data.steps.lastWhere((s) => x(s.$1) <= endX, orElse: () => data.steps.first);
    line.lineTo(endX, y(lastBefore.$2));

    final fill = Path.from(line)
      ..lineTo(endX, y(0))
      ..lineTo(0, y(0))
      ..close();
    canvas.drawPath(fill, Paint()..color = C.accent.withValues(alpha: 0.12));
    canvas.drawPath(
        line,
        Paint()
          ..color = C.accent
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.2
          ..strokeJoin = StrokeJoin.round);

    if (showNow && reveal >= 1 && data.until.isBefore(end)) {
      final nx = x(data.until);
      final dash = Paint()
        ..color = C.ink
        ..strokeWidth = 1;
      for (var dy = 0.0; dy < size.height - bottom; dy += 6) {
        canvas.drawLine(Offset(nx, dy), Offset(nx, math.min(dy + 3, size.height - bottom)), dash);
      }
      final dot = Offset(nx, y(lastBefore.$2));
      canvas.drawCircle(dot, 4.5, Paint()..color = Colors.white);
      canvas.drawCircle(
          dot,
          4.5,
          Paint()
            ..color = C.accent
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.5);
    }
  }

  @override
  bool shouldRepaint(_OccupancyPainter old) =>
      old.data != data || old.reveal != reveal || old.start != start || old.end != end;
}
