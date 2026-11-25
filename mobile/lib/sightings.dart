import 'dart:math' as math;

import 'api/models.dart';

/// Face sightings are grouped three ways on a person's day (by stay, by hour, a summary), so a day with hundreds of
/// sightings reads in a few rows. All of it is worked out here from what the app already loads.

const strongMatch = 0.60; // like the website: 60% and up is a strong match
const weakMatch = 0.50; // under 50% is weak

/// One stretch inside (a session of the day) with the face sightings in it.
class Stay {
  Stay({required this.start, required this.end, required this.ongoing, required this.sightings});
  final DateTime start;
  final DateTime end;

  /// Still going on (today, in the office): ends "now".
  final bool ongoing;

  /// Oldest first.
  final List<Sighting> sightings;

  Duration get length => end.difference(start);
  double get best => sightings.fold(0.0, (m, s) => math.max(m, s.similarity));
  bool get hasArrival => sightings.any((s) => s.arrived);

  /// Sightings per lens, lens number order.
  List<(int, int)> get perLens => lensCounts(sightings);
}

List<(int, int)> lensCounts(Iterable<Sighting> sightings) {
  final m = <int, int>{};
  for (final s in sightings) {
    m[s.channelNo] = (m[s.channelNo] ?? 0) + 1;
  }
  return (m.entries.map((e) => (e.key, e.value)).toList()..sort((a, b) => a.$1.compareTo(b.$1)));
}

/// Puts each sighting (oldest first) into the stay (inside session) it falls in. A sighting that falls between stays
/// goes with the stay that started last before it. Stays come back oldest first.
List<Stay> staysOf(List<Sighting> sightings, List<Span> sessions, {required bool ongoing, required DateTime now}) {
  if (sessions.isEmpty) {
    if (sightings.isEmpty) return const [];
    final last = sightings.last.seenAt;
    return [
      Stay(
          start: sightings.first.seenAt,
          end: ongoing && now.isAfter(last) ? now : last,
          ongoing: ongoing,
          sightings: [...sightings])
    ];
  }
  const slack = Duration(minutes: 1);
  final buckets = List.generate(sessions.length, (_) => <Sighting>[]);
  for (final s in sightings) {
    var idx = -1;
    for (var i = 0; i < sessions.length; i++) {
      final from = sessions[i].start.subtract(slack);
      final to = sessions[i].end.add(slack);
      if (!s.seenAt.isBefore(from) && !s.seenAt.isAfter(to)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      idx = 0;
      for (var i = 0; i < sessions.length; i++) {
        if (!sessions[i].start.isAfter(s.seenAt)) idx = i;
      }
    }
    buckets[idx].add(s);
  }
  final lastIdx = sessions.length - 1;
  return [
    for (var i = 0; i < sessions.length; i++)
      Stay(
        start: sessions[i].start,
        end: ongoing && i == lastIdx && now.isAfter(sessions[i].end) ? now : sessions[i].end,
        ongoing: ongoing && i == lastIdx,
        sightings: buckets[i],
      ),
  ];
}

/// One clock hour (local time) of sightings.
class HourGroup {
  HourGroup(this.hour, this.sightings);
  final DateTime hour; // local, on the hour
  final List<Sighting> sightings; // oldest first

  /// Minutes of the hour (0-59) with at least one sighting.
  Set<int> get minutes => {for (final s in sightings) s.seenAt.toLocal().minute};
}

/// Every hour from the first sighting's to the last one's, including hours with none (they show the gap). Oldest
/// first.
List<HourGroup> hoursOf(List<Sighting> sightings) {
  if (sightings.isEmpty) return const [];
  DateTime floor(DateTime t) {
    final l = t.toLocal();
    return DateTime(l.year, l.month, l.day, l.hour);
  }

  final first = floor(sightings.first.seenAt);
  final last = floor(sightings.last.seenAt);
  final groups = <DateTime, List<Sighting>>{};
  for (var h = first; !h.isAfter(last); h = DateTime(h.year, h.month, h.day, h.hour + 1)) {
    groups[h] = [];
  }
  for (final s in sightings) {
    groups[floor(s.seenAt)]?.add(s);
  }
  return [for (final e in groups.entries) HourGroup(e.key, e.value)];
}

/// Totals for the summary view.
class SightingStats {
  SightingStats._(this.total, this.first, this.last, this.perLens, this.strong, this.fair, this.weak);
  final int total;
  final DateTime? first;
  final DateTime? last;
  final List<(int, int)> perLens;
  final int strong;
  final int fair;
  final int weak;

  factory SightingStats.of(List<Sighting> sightings) {
    var strong = 0, fair = 0, weak = 0;
    for (final s in sightings) {
      if (s.similarity >= strongMatch) {
        strong++;
      } else if (s.similarity >= weakMatch) {
        fair++;
      } else {
        weak++;
      }
    }
    return SightingStats._(
      sightings.length,
      sightings.isEmpty ? null : sightings.first.seenAt,
      sightings.isEmpty ? null : sightings.last.seenAt,
      lensCounts(sightings),
      strong,
      fair,
      weak,
    );
  }
}
