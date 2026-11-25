import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import '../theme.dart';
import 'shimmer.dart';

/// Space at the bottom of a tab's scrolling content (the tab bar sits below the content, not over it).
const double kNavClearance = 28;

/// White rounded card with a soft shadow.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.onTap, this.radius = 20});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(radius), boxShadow: C.shadow),
      child: Material(
        color: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
      ),
    );
  }
}

/// Black card for the most important thing on a screen.
class HeroPanel extends StatelessWidget {
  const HeroPanel({super.key, required this.child, this.padding = const EdgeInsets.all(20)});
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(color: C.ink, borderRadius: BorderRadius.circular(24)),
        child: DefaultTextStyle.merge(style: const TextStyle(color: Colors.white), child: child),
      );
}

/// Big screen title inside the scrolling content ("Today", "Office time", ...).
class ScreenHeader extends StatelessWidget {
  const ScreenHeader({super.key, required this.title, this.subtitle, this.trailing});
  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 2),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Semantics(
              header: true,
              child: Text(title,
                  style: const TextStyle(
                      fontSize: 30, height: 1.2, fontWeight: FontWeight.w800, letterSpacing: -0.6, color: C.ink)),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 2),
              Text(subtitle!, style: const TextStyle(fontSize: 13, color: C.muted)),
            ],
          ]),
        ),
        if (trailing != null) Padding(padding: const EdgeInsets.only(top: 4), child: trailing!),
      ]),
    );
  }
}

/// "Live" chip whose dot sends out a few ripples each time the data refreshes ([pulseKey] changes), then rests.
class LiveDot extends StatefulWidget {
  const LiveDot({super.key, required this.color, this.pulseKey, this.size = 8});
  final Color color;
  final Object? pulseKey;
  final double size;

  @override
  State<LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<LiveDot> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500));
  int _left = 0;

  @override
  void initState() {
    super.initState();
    _c.addStatusListener((s) {
      if (s == AnimationStatus.completed && _left > 0) {
        _left--;
        _c.forward(from: 0);
      }
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _start();
  }

  @override
  void didUpdateWidget(LiveDot old) {
    super.didUpdateWidget(old);
    if (old.pulseKey != widget.pulseKey) _start();
  }

  void _start() {
    if (MediaQuery.of(context).disableAnimations) return;
    _left = 2; // three ripples in all
    _c.forward(from: 0);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) => DecoratedBox(
          decoration: BoxDecoration(
            color: widget.color,
            shape: BoxShape.circle,
            boxShadow: [
              if (_c.isAnimating)
                BoxShadow(color: widget.color.withValues(alpha: 0.5 * (1 - _c.value)), spreadRadius: 7 * _c.value),
            ],
          ),
        ),
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.subtitle, this.trailing});
  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 12, 4, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text(title,
                      style: const TextStyle(
                          fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.2, color: C.ink)),
                ),
                if (subtitle != null) Text(subtitle!, style: const TextStyle(fontSize: 12.5, color: C.muted)),
              ],
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.value, this.sub, this.icon, this.valueColor});
  final String label;
  final String value;
  final Widget? sub;
  final IconData? icon;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    return Panel(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      radius: 18,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                  child:
                      Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: C.muted))),
              if (icon != null) Icon(icon, size: 16, color: C.faint),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(
                fontSize: 24,
                height: 1,
                fontWeight: FontWeight.w800,
                letterSpacing: -0.4,
                color: valueColor ?? C.ink,
                fontFeatures: const [FontFeature.tabularFigures()]),
          ),
          if (sub != null) ...[
            const SizedBox(height: 6),
            DefaultTextStyle(
                style: const TextStyle(fontSize: 12, color: C.muted),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                child: sub!),
          ],
        ],
      ),
    );
  }
}

/// Two tiles per row.
class TileGrid extends StatelessWidget {
  const TileGrid({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i += 2) {
      rows.add(IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: children[i]),
            const SizedBox(width: 10),
            Expanded(child: i + 1 < children.length ? children[i + 1] : const SizedBox()),
          ],
        ),
      ));
      if (i + 2 < children.length) rows.add(const SizedBox(height: 10));
    }
    return Column(children: rows);
  }
}

// ---------------------------------------------------------------- presence

enum Tone { inOffice, away, out, present }

class Presence {
  const Presence(this.tone, this.label, this.order);
  final Tone tone;
  final String label;
  final int order;
}

/// Same wording as the website.
Presence presenceOf(WorkDayRow r, bool isToday) => switch (r.state) {
      PresenceState.inOffice => const Presence(Tone.inOffice, 'In office', 0),
      PresenceState.left =>
        isToday ? const Presence(Tone.away, 'Not seen now', 1) : const Presence(Tone.present, 'Was in', 1),
      PresenceState.absent => Presence(Tone.out, isToday ? 'Not in yet' : 'Absent', 2),
    };

/// The line under the status badge ("Seen 2m ago", "For 25m · since 10:40 AM", ...).
String? presenceDetail(WorkDayRow r, bool isToday, DateTime now) {
  if (isToday && r.state == PresenceState.inOffice && r.lastSeen != null) {
    return 'Seen ${timeAgo(r.lastSeen, now)}';
  }
  if (isToday && r.state == PresenceState.left && r.lastSeen != null) {
    return 'For ${fmtDur(now.difference(r.lastSeen!).inSeconds)} · since ${fmtTime(r.lastSeen)}';
  }
  if (!isToday && r.state == PresenceState.left && r.lastSeen != null) {
    return 'Last seen ${fmtTime(r.lastSeen)}';
  }
  if (r.state == PresenceState.absent && isToday && r.schedule != null) {
    return 'Due ${fmtTime(r.schedule!.startAt)}';
  }
  return null;
}

class PresenceBadge extends StatelessWidget {
  const PresenceBadge(this.presence, {super.key});
  final Presence presence;

  @override
  Widget build(BuildContext context) {
    final (dot, bg, fg) = switch (presence.tone) {
      Tone.inOffice => (C.green, C.greenSoft, C.greenText),
      Tone.away => (C.accent, C.amberSoft, C.amberText),
      Tone.out => (C.faint, C.blueSoft, C.muted),
      Tone.present => (C.ink, C.blueSoft, C.ink),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(width: 6, height: 6, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Text(presence.label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: fg)),
        ],
      ),
    );
  }
}

class LateTag extends StatelessWidget {
  const LateTag({super.key, this.minutes = 0});
  final int minutes;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: C.amberSoft, borderRadius: BorderRadius.circular(6)),
      child: Text(minutes > 0 ? 'Late · ${fmtMin(minutes)}' : 'Late',
          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: C.amberText)),
    );
  }
}

// ---------------------------------------------------------------- people

// Warm greys, black and orange, to sit with the Hashnate colours.
const _avatarTones = [
  (Color(0xFFE7E5E4), Color(0xFF292524)),
  (Color(0xFFFFEDD5), Color(0xFF9A3412)),
  (Color(0xFF292524), Color(0xFFFFFFFF)),
  (Color(0xFFF5F5F4), Color(0xFF44403C)),
  (Color(0xFFFED7AA), Color(0xFF7C2D12)),
  (Color(0xFFD6D3D1), Color(0xFF1C1917)),
];

class Avatar extends StatelessWidget {
  const Avatar({super.key, required this.name, this.id, this.size = 38});
  final String name;
  final String? id;
  final double size;

  @override
  Widget build(BuildContext context) {
    final key = id ?? name;
    var h = 0;
    for (final c in key.codeUnits) {
      h = (h * 31 + c) & 0xFFFFFFFF;
    }
    final (bg, fg) = _avatarTones[h % _avatarTones.length];
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
      child: Text(initials(name), style: TextStyle(color: fg, fontWeight: FontWeight.w700, fontSize: size * 0.33)),
    );
  }
}

// ---------------------------------------------------------------- states

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.message, this.action});
  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: const BoxDecoration(color: C.track, shape: BoxShape.circle),
            child: Icon(icon, color: C.faint, size: 22),
          ),
          const SizedBox(height: 12),
          Text(title,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: C.ink)),
          if (message != null) ...[
            const SizedBox(height: 4),
            Text(message!, textAlign: TextAlign.center, style: const TextStyle(fontSize: 13, color: C.muted)),
          ],
          if (action != null) ...[const SizedBox(height: 16), action!],
        ],
      ),
    );
  }
}

class ErrorPanel extends StatelessWidget {
  const ErrorPanel({super.key, required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Panel(
      child: EmptyState(
        icon: Icons.cloud_off_outlined,
        title: "Couldn't load this",
        message: message,
        action: OutlinedButton.icon(
            onPressed: onRetry, icon: const Icon(Icons.refresh, size: 18), label: const Text('Try again')),
      ),
    );
  }
}

/// Coloured strip at the top of a screen (recognition offline, etc.).
class AlertStrip extends StatelessWidget {
  const AlertStrip({super.key, required this.text, this.tone = Tone.away, this.icon = Icons.warning_amber_rounded});
  final String text;
  final Tone tone;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, border) = tone == Tone.out
        ? (C.roseSoft, C.roseText, const Color(0xFFFECDD3))
        : (C.amberSoft, C.amberText, const Color(0xFFFDE68A));
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12), border: Border.all(color: border)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: fg),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: TextStyle(fontSize: 13, color: fg, height: 1.35))),
        ],
      ),
    );
  }
}

/// A shimmering grey card while a screen loads (for simple layouts; see widgets/shimmer.dart for shaped ones).
class Skeleton extends StatelessWidget {
  const Skeleton({super.key, this.height = 16, this.width});
  final double height;
  final double? width;

  @override
  Widget build(BuildContext context) => Shimmer(child: Bone(height: height, width: width, radius: 20));
}

String healthLabel(Health h) => switch (h) {
      Health.live => 'Recognition live',
      Health.degraded => 'Camera connecting',
      Health.offline => 'Recognition offline',
    };

Color healthColor(Health h) => switch (h) {
      Health.live => C.green,
      Health.degraded => C.amber,
      Health.offline => C.rose,
    };

/// The app icon, drawn: black square, white scan brackets around a clock, one orange corner.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 44});
  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'WorkSight',
        image: true,
        child: SizedBox(width: size, height: size, child: const CustomPaint(painter: _MarkPainter())),
      );
}

class _MarkPainter extends CustomPainter {
  const _MarkPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 100;
    canvas.drawRRect(RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(24 * s)), Paint()..color = C.ink);
    Paint stroke(Color c) => Paint()
      ..color = c
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8 * s
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    Path corner(double x, double y, double dx, double dy) {
      // From the vertical arm end, round the corner at (x, y), to the horizontal arm end.
      return Path()
        ..moveTo(x * s, (y + dy * 18) * s)
        ..lineTo(x * s, (y + dy * 9) * s)
        ..arcToPoint(Offset((x + dx * 9) * s, y * s), radius: Radius.circular(9 * s), clockwise: dx * dy > 0)
        ..lineTo((x + dx * 18) * s, y * s);
    }

    final white = stroke(Colors.white);
    canvas.drawPath(corner(22, 22, 1, 1), white);
    canvas.drawPath(corner(78, 22, -1, 1), stroke(C.accent));
    canvas.drawPath(corner(22, 78, 1, -1), white);
    canvas.drawPath(corner(78, 78, -1, -1), white);
    canvas.drawPath(
        Path()
          ..moveTo(48 * s, 36 * s)
          ..lineTo(48 * s, 51 * s)
          ..lineTo(59 * s, 56 * s),
        white);
  }

  @override
  bool shouldRepaint(_MarkPainter old) => false;
}
