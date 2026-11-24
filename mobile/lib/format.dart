import 'package:intl/intl.dart';

/// 45s · 12m · 3m 20s · 7h 05m (same wording as the website).
String fmtDur(num totalSeconds) {
  final s = totalSeconds.round() < 0 ? 0 : totalSeconds.round();
  if (s < 60) return '${s}s';
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final sec = s % 60;
  if (h > 0) return '${h}h ${m.toString().padLeft(2, '0')}m';
  return (m < 10 && sec > 0) ? '${m}m ${sec}s' : '${m}m';
}

String fmtMin(num minutes) => fmtDur(minutes * 60);

/// 9:05 AM (phone's own clock format is not used, to match the website and exports).
String fmtTime(DateTime? t, {bool seconds = false}) {
  if (t == null) return '—';
  return DateFormat(seconds ? 'h:mm:ss a' : 'h:mm a').format(t.toLocal());
}

/// just now · 4m ago · 2:15 PM (earlier today) · 18 Nov, 5:17 PM
String timeAgo(DateTime? t, DateTime now) {
  if (t == null) return '—';
  final diff = now.difference(t);
  if (diff.inSeconds < 45) return 'just now';
  if (diff.inMinutes < 60) {
    return '${diff.inMinutes < 1 ? 1 : diff.inMinutes}m ago';
  }
  final local = t.toLocal();
  final n = now.toLocal();
  if (local.year == n.year && local.month == n.month && local.day == n.day) {
    return fmtTime(local);
  }
  return DateFormat('d MMM, h:mm a').format(local);
}

DateTime _ymd(String ymd) {
  final p = ymd.split('-').map(int.parse).toList();
  return DateTime.utc(p[0], p[1], p[2]);
}

/// "2026-11-24" -> "Tue 24 Nov" (or another [pattern]).
String fmtDate(String ymd, {String pattern = 'EEE d MMM'}) {
  try {
    return DateFormat(pattern).format(_ymd(ymd));
  } catch (_) {
    return ymd;
  }
}

/// "2026-11-24" + 1 -> "2026-11-25". Works on calendar dates, so time zones and DST don't matter.
String shiftDate(String ymd, int days) {
  final d = _ymd(ymd);
  final shifted = DateTime.utc(d.year, d.month, d.day + days);
  return DateFormat('yyyy-MM-dd').format(shifted);
}

String toYmd(DateTime d) => DateFormat('yyyy-MM-dd').format(d);

DateTime ymdToDate(String ymd) {
  final d = _ymd(ymd);
  return DateTime(d.year, d.month, d.day);
}

String initials(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
  return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
}
