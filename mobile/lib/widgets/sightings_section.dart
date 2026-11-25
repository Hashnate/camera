import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import '../sightings.dart';
import '../theme.dart';
import 'common.dart';

enum SightingsView { stays, hours, summary }

/// "Face sightings" on a person's day, shown three ways (the manager picks; by stay first), so hundreds of sightings
/// read in a few rows.
class SightingsSection extends StatefulWidget {
  const SightingsSection({
    super.key,
    required this.sightings,
    required this.total,
    required this.sessions,
    required this.ongoing,
    required this.isToday,
    required this.now,
    required this.awayAfterMinutes,
    required this.personName,
    required this.dayLabel,
  });

  /// Oldest first; null while loading.
  final List<Sighting>? sightings;
  final int total;
  final List<Span> sessions;
  final bool ongoing;
  final bool isToday;
  final DateTime now;
  final int awayAfterMinutes;
  final String personName;
  final String dayLabel;

  @override
  State<SightingsSection> createState() => _SightingsSectionState();
}

class _SightingsSectionState extends State<SightingsSection> {
  /// The last view picked, kept while the app is open.
  static SightingsView _remembered = SightingsView.stays;
  SightingsView _view = _remembered;

  void _pick(SightingsView v) {
    _remembered = v;
    setState(() => _view = v);
  }

  @override
  Widget build(BuildContext context) {
    final list = widget.sightings;
    final when = widget.isToday ? 'today' : 'on this day';
    final subtitle = switch (_view) {
      SightingsView.stays => '${widget.total} $when, grouped into stays · newest first',
      SightingsView.hours => '${widget.total} $when, by hour · green = seen that minute',
      SightingsView.summary => '${widget.total} $when',
    };

    final Widget body;
    if (list == null) {
      body = const Skeleton(height: 140);
    } else if (list.isEmpty) {
      body = Panel(child: Text('No face sightings $when.', style: const TextStyle(fontSize: 13, color: C.muted)));
    } else {
      body = switch (_view) {
        SightingsView.stays =>
          _StayView(stays: staysOf(list, widget.sessions, ongoing: widget.ongoing, now: widget.now).reversed.toList()),
        SightingsView.hours => _HourView(hours: hoursOf(list).reversed.toList(), now: widget.now),
        SightingsView.summary => _SummaryView(
            sightings: list,
            when: when,
            onSeeAll: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => AllSightingsScreen(
                sightings: list,
                personName: widget.personName,
                dayLabel: widget.dayLabel,
                awayAfterMinutes: widget.awayAfterMinutes,
              ),
            )),
          ),
      };
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SectionTitle('Face sightings', subtitle: subtitle),
      _ViewSwitch(value: _view, onPick: _pick),
      const SizedBox(height: 10),
      AnimatedSwitcher(
          duration: const Duration(milliseconds: 200), child: KeyedSubtree(key: ValueKey(_view), child: body)),
    ]);
  }
}

class _ViewSwitch extends StatelessWidget {
  const _ViewSwitch({required this.value, required this.onPick});
  final SightingsView value;
  final ValueChanged<SightingsView> onPick;

  @override
  Widget build(BuildContext context) {
    const items = [
      (SightingsView.stays, 'By stay'),
      (SightingsView.hours, 'By hour'),
      (SightingsView.summary, 'Summary'),
    ];
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: const Color(0xFFE9E8E6), borderRadius: BorderRadius.circular(12)),
      child: Row(children: [
        for (final (v, label) in items)
          Expanded(
            child: Semantics(
              button: true,
              selected: v == value,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => onPick(v),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 180),
                  height: 38,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: v == value ? Colors.white : Colors.transparent,
                    borderRadius: BorderRadius.circular(9),
                    boxShadow: v == value ? C.shadow : null,
                  ),
                  child: Text(label,
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: v == value ? FontWeight.w700 : FontWeight.w500,
                          color: v == value ? C.ink : C.muted)),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}

// ---------------------------------------------------------------- shared rows

class _SightingRow extends StatelessWidget {
  const _SightingRow(this.s);
  final Sighting s;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(children: [
        SizedBox(
            width: 96,
            child: Text(fmtTime(s.seenAt, seconds: true), style: const TextStyle(fontSize: 13, color: C.text))),
        if (s.arrived)
          Container(
            margin: const EdgeInsets.only(right: 8),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(color: C.greenSoft, borderRadius: BorderRadius.circular(6)),
            child:
                const Text('ARRIVED', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: C.greenText)),
          ),
        Expanded(child: Text('Lens ${s.channelNo}', style: const TextStyle(fontSize: 12.5, color: C.muted))),
        Text('${(s.similarity * 100).round()}%',
            style: TextStyle(fontSize: 12.5, color: s.similarity >= strongMatch ? C.greenText : C.muted)),
      ]),
    );
  }
}

/// The newest few sightings, or all of them after "Show all".
class _Sightings extends StatelessWidget {
  const _Sightings({required this.newestFirst, required this.all, required this.onShowAll});
  final List<Sighting> newestFirst;
  final bool all;
  final VoidCallback onShowAll;

  @override
  Widget build(BuildContext context) {
    const few = 3;
    final shown = all ? newestFirst : newestFirst.take(few).toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (final s in shown) _SightingRow(s),
      if (!all && newestFirst.length > few)
        TextButton(
          style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 40)),
          onPressed: onShowAll,
          child: Text('Show all ${newestFirst.length}', style: const TextStyle(fontWeight: FontWeight.w600)),
        ),
    ]);
  }
}

String _lensText(List<(int, int)> perLens) {
  if (perLens.isEmpty) return '';
  if (perLens.length == 1) return 'all on Lens ${perLens.first.$1}';
  return perLens.map((e) => 'Lens ${e.$1}: ${e.$2}').join(' · ');
}

String _plural(int n, String one) => '$n $one${n == 1 ? '' : 's'}';

class _Best extends StatelessWidget {
  const _Best(this.best);
  final double best;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
        const Text('best', style: TextStyle(fontSize: 11.5, color: C.muted)),
        Text(best > 0 ? '${(best * 100).round()}%' : '—',
            style: TextStyle(
                fontSize: 15, fontWeight: FontWeight.w700, color: best >= strongMatch ? C.greenText : C.text)),
      ]);
}

// ---------------------------------------------------------------- A: by stay

class _StayView extends StatefulWidget {
  const _StayView({required this.stays});

  /// Newest first.
  final List<Stay> stays;

  @override
  State<_StayView> createState() => _StayViewState();
}

class _StayViewState extends State<_StayView> {
  final _open = <DateTime>{};
  final _all = <DateTime>{};

  @override
  void initState() {
    super.initState();
    if (widget.stays.isNotEmpty) _open.add(widget.stays.first.start); // the latest stay starts open
  }

  String _range(Stay s) {
    var a = fmtTime(s.start);
    final b = s.ongoing ? 'now' : fmtTime(s.end);
    if (!s.ongoing && a.length > 3 && b.length > 3 && a.substring(a.length - 2) == b.substring(b.length - 2)) {
      a = a.substring(0, a.length - 3); // "5:05 – 5:58 PM"
    }
    return '$a – $b';
  }

  @override
  Widget build(BuildContext context) {
    final stays = widget.stays;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      for (var i = 0; i < stays.length; i++) ...[
        if (i > 0) _AwayLine(seconds: stays[i - 1].start.difference(stays[i].end).inSeconds),
        _stayCard(stays[i], chronoIndex: stays.length - 1 - i),
      ],
    ]);
  }

  Widget _stayCard(Stay s, {required int chronoIndex}) {
    final open = _open.contains(s.start);
    final n = s.sightings.length;
    final detail = '${fmtDur(s.length.inSeconds)} inside · ${_plural(n, 'sighting')}';
    final lenses = n > 0 ? _lensText(s.perLens) : null;
    return Panel(
      padding: EdgeInsets.zero,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Semantics(
          button: true,
          expanded: open,
          child: InkWell(
            key: ValueKey('stay-header-$chronoIndex'),
            onTap: () => setState(() => open ? _open.remove(s.start) : _open.add(s.start)),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
              child: IntrinsicHeight(
                child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Container(
                      width: 4, decoration: BoxDecoration(color: C.inside, borderRadius: BorderRadius.circular(2))),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(_range(s), style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: C.ink)),
                      const SizedBox(height: 2),
                      Text(detail, style: const TextStyle(fontSize: 12.5, color: C.muted)),
                      if (lenses != null) ...[
                        const SizedBox(height: 1),
                        Text(lenses, style: const TextStyle(fontSize: 12, color: C.subtle)),
                      ],
                    ]),
                  ),
                  const SizedBox(width: 8),
                  _Best(s.best),
                  const SizedBox(width: 4),
                  Center(
                    child: AnimatedRotation(
                      turns: open ? 0.5 : 0,
                      duration: const Duration(milliseconds: 180),
                      child: const Icon(Icons.expand_more, color: C.faint),
                    ),
                  ),
                ]),
              ),
            ),
          ),
        ),
        if (open) ...[
          const Divider(),
          Padding(
            padding: const EdgeInsets.fromLTRB(32, 4, 16, 8),
            child: n == 0
                ? const Padding(
                    padding: EdgeInsets.symmetric(vertical: 8),
                    child: Text('No face seen in this stay: the cameras followed them without a face.',
                        style: TextStyle(fontSize: 12.5, color: C.muted)),
                  )
                : _Sightings(
                    newestFirst: s.sightings.reversed.toList(),
                    all: _all.contains(s.start),
                    onShowAll: () => setState(() => _all.add(s.start)),
                  ),
          ),
        ],
      ]),
    );
  }
}

class _AwayLine extends StatelessWidget {
  const _AwayLine({required this.seconds});
  final int seconds;

  @override
  Widget build(BuildContext context) {
    if (seconds <= 0) return const SizedBox(height: 10);
    const line = Expanded(child: Divider(color: C.amberLight, thickness: 1.5));
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(children: [
        line,
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Text('away ${fmtDur(seconds)}',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: C.amberText)),
        ),
        line,
      ]),
    );
  }
}

// ---------------------------------------------------------------- B: by hour

class _HourView extends StatefulWidget {
  const _HourView({required this.hours, required this.now});

  /// Newest first.
  final List<HourGroup> hours;
  final DateTime now;

  @override
  State<_HourView> createState() => _HourViewState();
}

class _HourViewState extends State<_HourView> {
  final _open = <DateTime>{};
  final _all = <DateTime>{};

  @override
  void initState() {
    super.initState();
    if (widget.hours.isNotEmpty) _open.add(widget.hours.first.hour);
  }

  @override
  Widget build(BuildContext context) {
    final hours = widget.hours;
    final nowLocal = widget.now.toLocal();
    return Panel(
      padding: EdgeInsets.zero,
      child: Column(children: [
        for (var i = 0; i < hours.length; i++) ...[
          if (i > 0) const Divider(),
          _hourRow(hours[i], i, nowLocal),
        ],
      ]),
    );
  }

  Widget _hourRow(HourGroup h, int i, DateTime nowLocal) {
    final open = _open.contains(h.hour);
    final label = fmtTime(h.hour).replaceFirst(':00', '');
    // In the hour that is still going on, minutes still to come are left blank.
    final upTo = nowLocal.isBefore(h.hour.add(const Duration(hours: 1)))
        ? math.max(0, nowLocal.difference(h.hour).inMinutes + 1)
        : 60;
    final minutes = h.minutes;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Semantics(
        button: true,
        expanded: open,
        label: '$label: seen in ${minutes.length} minutes, ${_plural(h.sightings.length, 'sighting')}',
        child: InkWell(
          key: ValueKey('hour-row-$i'),
          onTap: h.sightings.isEmpty ? null : () => setState(() => open ? _open.remove(h.hour) : _open.add(h.hour)),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 13, 12, 13),
            child: Row(children: [
              SizedBox(
                  width: 50,
                  child: Text(label, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: C.ink))),
              Expanded(
                child: SizedBox(
                  height: 18,
                  child: CustomPaint(painter: _MinuteStrip(minutes, upTo)),
                ),
              ),
              SizedBox(
                width: 40,
                child: Text('${h.sightings.length}',
                    textAlign: TextAlign.right,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: C.ink)),
              ),
              const SizedBox(width: 4),
              AnimatedRotation(
                turns: open ? 0.5 : 0,
                duration: const Duration(milliseconds: 180),
                child: Icon(Icons.expand_more, color: h.sightings.isEmpty ? Colors.transparent : C.faint),
              ),
            ]),
          ),
        ),
      ),
      if (open && h.sightings.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(66, 0, 16, 8),
          child: _Sightings(
            newestFirst: h.sightings.reversed.toList(),
            all: _all.contains(h.hour),
            onShowAll: () => setState(() => _all.add(h.hour)),
          ),
        ),
    ]);
  }
}

class _MinuteStrip extends CustomPainter {
  _MinuteStrip(this.minutes, this.upTo);
  final Set<int> minutes;
  final int upTo;

  @override
  void paint(Canvas canvas, Size size) {
    const gap = 1.0;
    final w = (size.width - gap * 59) / 60;
    final seen = Paint()..color = C.inside;
    final empty = Paint()..color = C.track;
    for (var m = 0; m < math.min(upTo, 60); m++) {
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(m * (w + gap), 0, w, size.height), const Radius.circular(1)),
        minutes.contains(m) ? seen : empty,
      );
    }
  }

  @override
  bool shouldRepaint(_MinuteStrip old) => old.upTo != upTo || old.minutes.length != minutes.length;
}

// ---------------------------------------------------------------- C: summary

class _SummaryView extends StatelessWidget {
  const _SummaryView({required this.sightings, required this.when, required this.onSeeAll});
  final List<Sighting> sightings;
  final String when;
  final VoidCallback onSeeAll;

  static const _lensColors = [C.ink, C.faint, C.amberLight, C.subtle];

  @override
  Widget build(BuildContext context) {
    final st = SightingStats.of(sightings);
    final hours = hoursOf(sightings);
    final peak = hours.fold(1, (m, h) => math.max(m, h.sightings.length));
    final newest = sightings.reversed.take(3).toList();

    Widget label(String t) =>
        Text(t, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: C.muted));
    Widget key(Color c, String t) => Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 9, height: 9, decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(2))),
          const SizedBox(width: 6),
          Text(t, style: const TextStyle(fontSize: 12.5, color: C.text)),
        ]);
    Widget stacked(List<(int, Color)> parts) => ClipRRect(
          borderRadius: BorderRadius.circular(5),
          child: SizedBox(
            height: 10,
            width: double.infinity,
            // stretch: the coloured parts take the bar's full height (they have no size of their own)
            child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (var i = 0; i < parts.length; i++)
                if (parts[i].$1 > 0) ...[
                  if (i > 0) const SizedBox(width: 2),
                  Expanded(flex: parts[i].$1, child: ColoredBox(color: parts[i].$2)),
                ],
            ]),
          ),
        );

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Panel(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('${st.total}',
                style: const TextStyle(fontSize: 34, height: 1.05, fontWeight: FontWeight.w800, color: C.ink)),
            const SizedBox(width: 8),
            Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(when, style: const TextStyle(fontSize: 13, color: C.muted))),
            const Spacer(),
            Text('first ${fmtTime(st.first)}\nlast ${fmtTime(st.last)}',
                textAlign: TextAlign.right, style: const TextStyle(fontSize: 12.5, height: 1.4, color: C.muted)),
          ]),
          const SizedBox(height: 16),
          label('Per hour'),
          const SizedBox(height: 6),
          Semantics(
            label: 'Sightings per hour: ${hours.map((h) => h.sightings.length).join(', ')}',
            child: SizedBox(
              height: 64,
              child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                for (var i = 0; i < hours.length; i++) ...[
                  if (i > 0) const SizedBox(width: 5),
                  Expanded(
                    child: Container(
                      height: math.max(3, 64 * hours[i].sightings.length / peak),
                      decoration: BoxDecoration(
                          color: C.inside,
                          borderRadius:
                              const BorderRadius.vertical(top: Radius.circular(4), bottom: Radius.circular(1))),
                    ),
                  ),
                ],
              ]),
            ),
          ),
          const SizedBox(height: 4),
          Row(children: [
            for (var i = 0; i < hours.length; i++) ...[
              if (i > 0) const SizedBox(width: 5),
              Expanded(
                child: Text(
                  i.isEven || hours.length <= 8 ? fmtTime(hours[i].hour).split(':').first : '',
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 10.5, color: C.subtle),
                ),
              ),
            ],
          ]),
          const SizedBox(height: 16),
          label('Which camera'),
          const SizedBox(height: 6),
          stacked([
            for (var i = 0; i < st.perLens.length; i++) (st.perLens[i].$2, _lensColors[i % _lensColors.length]),
          ]),
          const SizedBox(height: 6),
          Wrap(spacing: 16, runSpacing: 4, children: [
            for (var i = 0; i < st.perLens.length; i++)
              key(_lensColors[i % _lensColors.length], 'Lens ${st.perLens[i].$1} · ${st.perLens[i].$2}'),
          ]),
          const SizedBox(height: 16),
          label('How sure the match was'),
          const SizedBox(height: 6),
          stacked([(st.strong, C.inside), (st.fair, const Color(0xFFA7F3D0)), (st.weak, C.accent)]),
          const SizedBox(height: 6),
          Wrap(spacing: 14, runSpacing: 4, children: [
            key(C.inside, 'Strong 60%+ · ${st.strong}'),
            key(const Color(0xFFA7F3D0), 'Fair · ${st.fair}'),
            key(C.accent, 'Weak under 50% · ${st.weak}'),
          ]),
        ]),
      ),
      const SizedBox(height: 10),
      Panel(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          label('Latest'),
          for (final s in newest) _SightingRow(s),
          const Divider(),
          InkWell(
            onTap: onSeeAll,
            child: SizedBox(
              height: 48,
              child: Row(children: [
                Expanded(
                  child: Text('See all ${_plural(st.total, 'sighting')}',
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: C.accentText)),
                ),
                const Icon(Icons.chevron_right, color: C.accentText),
              ]),
            ),
          ),
        ]),
      ),
    ]);
  }
}

// ---------------------------------------------------------------- full list

/// Every sighting of the day, newest first, with filters by lens and match strength.
class AllSightingsScreen extends StatefulWidget {
  const AllSightingsScreen({
    super.key,
    required this.sightings,
    required this.personName,
    required this.dayLabel,
    required this.awayAfterMinutes,
  });
  final List<Sighting> sightings; // oldest first
  final String personName;
  final String dayLabel;
  final int awayAfterMinutes;

  @override
  State<AllSightingsScreen> createState() => _AllSightingsScreenState();
}

class _AllSightingsScreenState extends State<AllSightingsScreen> {
  /// null = all, a lens number, or -1 = strong matches only.
  int? _filter;

  @override
  Widget build(BuildContext context) {
    final all = widget.sightings;
    final lenses = lensCounts(all);
    final strong = all.where((s) => s.similarity >= strongMatch).length;
    final shown = all
        .where((s) => switch (_filter) {
              null => true,
              -1 => s.similarity >= strongMatch,
              final lens => s.channelNo == lens,
            })
        .toList()
        .reversed
        .toList();

    Widget chip(int? value, String label) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            label: Text(label),
            selected: _filter == value,
            onSelected: (_) => setState(() => _filter = value),
            labelStyle:
                TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: _filter == value ? Colors.white : C.text),
          ),
        );

    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('All sightings'),
          Text('${widget.personName} · ${widget.dayLabel}',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w400, color: C.muted)),
        ]),
      ),
      body: Column(children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
          child: Row(children: [
            chip(null, 'All · ${all.length}'),
            for (final (lens, n) in lenses) chip(lens, 'Lens $lens · $n'),
            chip(-1, 'Strong 60%+ · $strong'),
          ]),
        ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            itemCount: shown.length,
            itemBuilder: (context, i) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: _SightingRow(shown[i]),
            ),
            separatorBuilder: (context, i) {
              final gap = shown[i].seenAt.difference(shown[i + 1].seenAt).inSeconds;
              if (_filter == null && gap > widget.awayAfterMinutes * 60) {
                return Container(
                  margin: const EdgeInsets.symmetric(vertical: 2),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                  decoration: BoxDecoration(color: C.amberSoft, borderRadius: BorderRadius.circular(8)),
                  child: Text('No face for ${fmtDur(gap)}', style: const TextStyle(fontSize: 12, color: C.amberText)),
                );
              }
              return const Divider(height: 1);
            },
          ),
        ),
      ]),
    );
  }
}
