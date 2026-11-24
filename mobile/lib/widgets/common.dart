import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import '../theme.dart';

/// White rounded card, like the website's cards.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.onTap});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: C.line)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(onTap: onTap, child: Padding(padding: padding, child: child)),
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
      padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: C.ink)),
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
                fontWeight: FontWeight.w600,
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
      Tone.away => (C.amber, C.amberSoft, C.amberText),
      Tone.out => (C.faint, const Color(0xFFF8FAFC), C.muted),
      Tone.present => (C.blue, C.blueSoft, const Color(0xFF1D4ED8)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(width: 6, height: 6, decoration: BoxDecoration(color: dot, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Text(presence.label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: fg)),
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
      decoration: BoxDecoration(color: C.roseSoft, borderRadius: BorderRadius.circular(6)),
      child: Text(minutes > 0 ? 'Late · ${fmtMin(minutes)}' : 'Late',
          style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: C.roseText)),
    );
  }
}

// ---------------------------------------------------------------- people

const _avatarTones = [
  (Color(0xFFDBEAFE), Color(0xFF1D4ED8)),
  (Color(0xFFEDE9FE), Color(0xFF6D28D9)),
  (Color(0xFFCCFBF1), Color(0xFF0F766E)),
  (Color(0xFFFFEDD5), Color(0xFFC2410C)),
  (Color(0xFFFCE7F3), Color(0xFFBE185D)),
  (Color(0xFFE0F2FE), Color(0xFF0369A1)),
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
      child: Text(initials(name), style: TextStyle(color: fg, fontWeight: FontWeight.w600, fontSize: size * 0.34)),
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

class Skeleton extends StatelessWidget {
  const Skeleton({super.key, this.height = 16, this.width});
  final double height;
  final double? width;

  @override
  Widget build(BuildContext context) => Container(
      height: height, width: width, decoration: BoxDecoration(color: C.track, borderRadius: BorderRadius.circular(8)));
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

/// The app mark (same as the website sidebar).
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 44});
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: C.blue, borderRadius: BorderRadius.circular(size * 0.27)),
      child: Icon(Icons.face_retouching_natural, color: Colors.white, size: size * 0.5),
    );
  }
}
