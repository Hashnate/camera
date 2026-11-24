import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/timeline.dart';
import 'person_day_screen.dart';

enum _Filter { all, inOffice, away, out, late }

/// Each employee's day inside the office, for today or any past day.
class OfficeTimeScreen extends StatefulWidget {
  const OfficeTimeScreen({super.key, required this.active});
  final bool active;

  @override
  State<OfficeTimeScreen> createState() => _OfficeTimeScreenState();
}

class _OfficeTimeScreenState extends State<OfficeTimeScreen> {
  /// Null = today.
  String? _date;
  DailyReport? _daily;
  bool _loading = true;
  String? _error;
  _Filter _filter = _Filter.all;
  String _query = '';
  DateTime _now = DateTime.now();
  Timer? _timer;
  int _requestId = 0;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (widget.active && (_daily?.isToday ?? false)) _load(quiet: true);
    });
  }

  @override
  void didUpdateWidget(OfficeTimeScreen old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active && (_daily?.isToday ?? true)) {
      _load(quiet: true);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    final id = ++_requestId;
    if (!quiet && !_loading) setState(() => _loading = true);
    try {
      final daily = await SessionScope.read(context).api.daily(date: _date);
      if (!mounted || id != _requestId) return;
      setState(() {
        _daily = daily;
        _error = null;
        _now = DateTime.now();
        if (_filter == _Filter.inOffice && !daily.isToday) {
          _filter = _Filter.all;
        }
      });
    } on ApiException catch (e) {
      if (mounted && id == _requestId) setState(() => _error = e.message);
    } finally {
      if (mounted && id == _requestId) setState(() => _loading = false);
    }
  }

  void _goTo(String? date) {
    final today = _daily?.today;
    setState(() => _date = (date != null && date == today) ? null : date);
    _load();
  }

  Future<void> _pickDate() async {
    final d = _daily;
    if (d == null) return;
    final picked = await showDatePicker(
      context: context,
      initialDate: ymdToDate(d.date),
      firstDate: DateTime(2024),
      lastDate: ymdToDate(d.today),
    );
    if (picked != null) _goTo(toYmd(picked));
  }

  bool _matches(WorkDayRow r, bool isToday) {
    final ok = switch (_filter) {
      _Filter.all => true,
      _Filter.inOffice => r.state == PresenceState.inOffice,
      _Filter.away => r.state == PresenceState.left,
      _Filter.out => r.state == PresenceState.absent,
      _Filter.late => r.isLate,
    };
    if (!ok) return false;
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return true;
    final e = r.employee;
    return e.fullName.toLowerCase().contains(q) ||
        e.employeeCode.toLowerCase().contains(q) ||
        (e.department ?? '').toLowerCase().contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final d = _daily;
    final isToday = d?.isToday ?? true;
    final rows = d == null
        ? const <WorkDayRow>[]
        : (d.rows.where((r) => _matches(r, isToday)).toList()..sort((a, b) => _order(a, b, isToday)));
    final window = d == null ? null : timeWindow(d.rows, isToday: isToday, now: _now);

    int count(_Filter f) => d == null
        ? 0
        : d.rows
            .where((r) => switch (f) {
                  _Filter.all => true,
                  _Filter.inOffice => r.state == PresenceState.inOffice,
                  _Filter.away => r.state == PresenceState.left,
                  _Filter.out => r.state == PresenceState.absent,
                  _Filter.late => r.isLate,
                })
            .length;

    final filters = [
      (_Filter.all, 'Everyone'),
      if (isToday) (_Filter.inOffice, 'In office'),
      (_Filter.away, isToday ? 'Not seen now' : 'Was in'),
      (_Filter.out, isToday ? 'Not in yet' : 'Absent'),
      (_Filter.late, 'Late'),
    ];

    return Scaffold(
      appBar: AppBar(
        title: const Text('Office time'),
        actions: [
          if (_loading)
            const Padding(
                padding: EdgeInsets.only(right: 16),
                child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  // Day picker
                  Row(children: [
                    _RoundButton(
                      icon: Icons.chevron_left,
                      tooltip: 'Previous day',
                      onTap: d == null ? null : () => _goTo(shiftDate(d.date, -1)),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Material(
                        color: Colors.white,
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10), side: const BorderSide(color: C.line)),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(10),
                          onTap: _pickDate,
                          child: SizedBox(
                            height: 42,
                            child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                              const Icon(Icons.calendar_today_outlined, size: 16, color: C.muted),
                              const SizedBox(width: 8),
                              Flexible(
                                child: Text(
                                  d == null
                                      ? 'Loading…'
                                      : (d.isToday
                                          ? 'Today · ${fmtDate(d.date, pattern: 'd MMM')}'
                                          : fmtDate(d.date, pattern: 'EEE d MMM yyyy')),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: C.ink),
                                ),
                              ),
                            ]),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    _RoundButton(
                      icon: Icons.chevron_right,
                      tooltip: 'Next day',
                      onTap: (d == null || d.isToday) ? null : () => _goTo(shiftDate(d.date, 1)),
                    ),
                  ]),
                  if (d != null && !d.isToday)
                    Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(onPressed: () => _goTo(null), child: const Text('Back to today'))),
                  const SizedBox(height: 10),
                  TextField(
                    onChanged: (v) => setState(() => _query = v),
                    textInputAction: TextInputAction.search,
                    decoration: const InputDecoration(
                        hintText: 'Search name, code, team', prefixIcon: Icon(Icons.search, size: 20)),
                  ),
                  const SizedBox(height: 10),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(children: [
                      for (final (f, label) in filters) ...[
                        ChoiceChip(
                          label: Text('$label  ${count(f)}'),
                          selected: _filter == f,
                          onSelected: (_) => setState(() => _filter = f),
                          showCheckmark: false,
                          selectedColor: C.ink,
                          labelStyle: TextStyle(
                              fontSize: 13, color: _filter == f ? Colors.white : C.text, fontWeight: FontWeight.w500),
                          side: const BorderSide(color: C.line),
                          backgroundColor: Colors.white,
                          shape: const StadiumBorder(),
                        ),
                        const SizedBox(width: 8),
                      ],
                    ]),
                  ),
                ]),
              ),
            ),
            if (_error != null && d == null)
              SliverPadding(
                  padding: const EdgeInsets.all(16),
                  sliver: SliverToBoxAdapter(child: ErrorPanel(message: _error!, onRetry: _load)))
            else if (d == null)
              const SliverPadding(
                padding: EdgeInsets.all(16),
                sliver: SliverToBoxAdapter(
                    child: Column(children: [Skeleton(height: 120), SizedBox(height: 10), Skeleton(height: 120)])),
              )
            else if (rows.isEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Panel(
                    child: d.rows.isEmpty
                        ? const EmptyState(
                            icon: Icons.groups_outlined,
                            title: 'No active employees',
                            message: 'Add employees and enrol their faces on the website.')
                        : EmptyState(
                            icon: Icons.search_off,
                            title: 'Nobody matches',
                            message: 'Try another filter or search.',
                            action: OutlinedButton(
                                onPressed: () => setState(() => _filter = _Filter.all),
                                child: const Text('Show everyone')),
                          ),
                  ),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                sliver: SliverList.separated(
                  itemCount: rows.length + 1,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (context, i) {
                    if (i == rows.length) {
                      return Padding(padding: const EdgeInsets.only(top: 6), child: TimelineLegend(isToday: isToday));
                    }
                    final r = rows[i];
                    return _PersonCard(
                      row: r,
                      isToday: isToday,
                      now: _now,
                      window: window,
                      onTap: () => Navigator.of(context).push(MaterialPageRoute(
                        builder: (_) => PersonDayScreen(
                            employeeId: r.employee.id, name: r.employee.fullName, date: d.isToday ? null : d.date),
                      )),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }

  int _order(WorkDayRow a, WorkDayRow b, bool isToday) {
    final pa = presenceOf(a, isToday).order;
    final pb = presenceOf(b, isToday).order;
    return pa != pb ? pa.compareTo(pb) : a.employee.fullName.compareTo(b.employee.fullName);
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({required this.icon, required this.tooltip, this.onTap});
  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: const BorderSide(color: C.line)),
      child: IconButton(onPressed: onTap, tooltip: tooltip, icon: Icon(icon), color: C.ink, disabledColor: C.line),
    );
  }
}

class _PersonCard extends StatelessWidget {
  const _PersonCard(
      {required this.row, required this.isToday, required this.now, required this.window, required this.onTap});
  final WorkDayRow row;
  final bool isToday;
  final DateTime now;
  final ({DateTime start, DateTime end})? window;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final e = row.employee;
    final p = presenceOf(row, isToday);
    final detail = presenceDetail(row, isToday, now);
    final pct = row.percentOfSchedule;

    Widget stat(String label, Widget value) => Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label, style: const TextStyle(fontSize: 11.5, color: C.muted)),
            const SizedBox(height: 3),
            value,
          ]),
        );
    const strong = TextStyle(
        fontSize: 14, fontWeight: FontWeight.w600, color: C.ink, fontFeatures: [FontFeature.tabularFigures()]);

    return Panel(
      onTap: onTap,
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Avatar(name: e.fullName, id: e.id),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(e.fullName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: row.state == PresenceState.absent ? C.muted : C.ink)),
              Text([e.employeeCode, if (e.department != null) e.department!].join(' · '),
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5, color: C.muted)),
            ]),
          ),
          const Icon(Icons.chevron_right, color: C.faint),
        ]),
        Padding(
          padding: const EdgeInsets.only(left: 50, top: 8),
          child: Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
            PresenceBadge(p),
            if (detail != null) Text(detail, style: const TextStyle(fontSize: 12, color: C.muted)),
          ]),
        ),
        if (row.wasSeen) ...[
          const SizedBox(height: 12),
          const Divider(),
          const SizedBox(height: 10),
          Row(children: [
            stat(
              'Arrived',
              Wrap(spacing: 6, runSpacing: 3, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text(fmtTime(row.arrived), style: strong),
                if (row.isLate) const LateTag(),
              ]),
            ),
            stat(
              'Inside',
              Text.rich(TextSpan(children: [
                TextSpan(text: fmtDur(row.insideSeconds), style: strong),
                if (pct != null) TextSpan(text: '  $pct%', style: const TextStyle(fontSize: 11.5, color: C.muted)),
              ])),
            ),
            stat(
              'Away',
              row.awayPeriods.isEmpty
                  ? const Text('None', style: TextStyle(fontSize: 13, color: C.faint))
                  : Text('${fmtDur(row.awaySeconds)} · ${row.awayPeriods.length}×',
                      style: strong.copyWith(color: C.amberText)),
            ),
          ]),
          if (window != null) ...[
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child:
                  TimelineBar(row: row, start: window!.start, end: window!.end, now: now, isToday: isToday, height: 10),
            ),
          ],
        ],
      ]),
    );
  }
}
