import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.status});
  final String message;
  final int? status;

  bool get unauthorized => status == 401;

  @override
  String toString() => message;
}

/// Talks to one WorkSight server (each customer runs their own) with the signed-in manager's token.
class ApiClient {
  ApiClient(this.baseUrl, {this.token, http.Client? httpClient}) : _http = httpClient ?? http.Client();

  /// e.g. https://worksight.hashnate.com (no trailing slash, no /api).
  final String baseUrl;
  String? token;
  final http.Client _http;

  /// Called when the server says the sign-in is no longer valid.
  void Function()? onUnauthorized;

  static const _timeout = Duration(seconds: 20);

  /// "worksight.example.com", "https://worksight.example.com/api/" -> "https://worksight.example.com".
  static String normalizeServer(String input) {
    var s = input.trim();
    if (s.isEmpty) return s;
    if (!s.contains('://')) s = 'https://$s';
    s = s.replaceAll(RegExp(r'/+$'), '');
    if (s.endsWith('/api')) s = s.substring(0, s.length - 4);
    return s;
  }

  Uri uri(String path, [Map<String, String>? query]) {
    final u = Uri.parse('$baseUrl/api$path');
    return (query == null || query.isEmpty) ? u : u.replace(queryParameters: {...u.queryParameters, ...query});
  }

  Map<String, String> get authHeaders => token == null ? const {} : {'Authorization': 'Bearer $token'};

  Future<Map<String, dynamic>> getJson(String path, {Map<String, String>? query}) =>
      _send(path, () => _http.get(uri(path, query), headers: {...authHeaders, 'Accept': 'application/json'}));

  Future<Map<String, dynamic>> postJson(String path, [Object? body]) => _send(
        path,
        () => _http.post(
          uri(path),
          headers: {...authHeaders, 'Accept': 'application/json', 'Content-Type': 'application/json'},
          body: body == null ? null : jsonEncode(body),
        ),
      );

  Future<Map<String, dynamic>> _send(String path, Future<http.Response> Function() request) async {
    final http.Response res;
    try {
      res = await request().timeout(_timeout);
    } on TimeoutException {
      throw ApiException('The server took too long to answer. Try again.');
    } catch (_) {
      throw ApiException("Can't reach the server. Check your internet connection.");
    }

    Map<String, dynamic> data = const {};
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      if (decoded is Map) data = decoded.cast<String, dynamic>();
    } catch (_) {
      // Not JSON (e.g. a proxy error page); fall through to the status code.
    }

    if (res.statusCode >= 200 && res.statusCode < 300) return data;

    if (res.statusCode == 401 && token != null && !path.startsWith('/auth/login')) {
      onUnauthorized?.call();
    }
    final message = data['message']?.toString();
    throw ApiException(
      message != null && message.isNotEmpty ? message : 'The server answered with an error (HTTP ${res.statusCode}).',
      status: res.statusCode,
    );
  }

  // ---------------------------------------------------------------- endpoints

  /// True when this address is a WorkSight server.
  Future<bool> isWorkSightServer() async {
    final data = await getJson('/health');
    return (data['service']?.toString() ?? '').contains('WorkSight');
  }

  Future<({String token, SessionUser user})> login(String email, String password) async {
    final data = await postJson('/auth/login', {'email': email, 'password': password});
    final t = data['token'];
    final u = data['user'];
    if (t is! String || u is! Map) {
      throw ApiException('Unexpected answer from the server.');
    }
    return (token: t, user: SessionUser.fromJson(u.cast<String, dynamic>()));
  }

  Future<SessionUser> me() async {
    final data = await getJson('/auth/me');
    final u = data['user'];
    if (u is! Map) throw ApiException('Unexpected answer from the server.');
    return SessionUser.fromJson(u.cast<String, dynamic>());
  }

  /// Ends the session on the server too (best effort).
  Future<void> logout() async {
    try {
      await postJson('/auth/logout');
    } catch (_) {}
  }

  /// Everyone's office time on [date] ("YYYY-MM-DD"), or today.
  Future<DailyReport> daily({String? date}) async =>
      DailyReport.fromJson(await getJson('/work-hours/daily', query: date == null ? null : {'date': date}));

  /// Every face sighting of one person on one day, oldest first.
  Future<List<Sighting>> sightings(String employeeId, String date) async {
    final data = await getJson('/work-hours/$employeeId/sightings', query: {'date': date});
    final list = data['data'];
    if (list is! List) return const [];
    return list
        .whereType<Map>()
        .map((e) => Sighting.fromJson(e.cast<String, dynamic>()))
        .whereType<Sighting>()
        .toList();
  }

  /// Never throws: an unreachable AI service is itself a status.
  Future<RecognitionStatus> recognitionStatus() async {
    try {
      final data = await getJson('/recognition/status');
      final d = data['data'];
      return d is Map
          ? RecognitionStatus.fromJson(d.cast<String, dynamic>())
          : RecognitionStatus.unreachable('No status');
    } on ApiException catch (e) {
      return RecognitionStatus.unreachable(e.message);
    }
  }

  /// Latest faces recognised by the cameras. Never throws (the feed is secondary).
  Future<List<RecognitionEvent>> recentSightings({int limit = 8}) async {
    try {
      final data = await getJson('/recognition/events', query: {'limit': '$limit'});
      final list = data['data'];
      if (list is! List) return const [];
      return list
          .whereType<Map>()
          .map((e) => RecognitionEvent.fromJson(e.cast<String, dynamic>()))
          .whereType<RecognitionEvent>()
          .where((e) => e.action != 'IGNORED_INACTIVE')
          .toList();
    } on ApiException {
      return const [];
    }
  }

  Future<List<Camera>> cameras() async {
    final data = await getJson('/cameras');
    final list = data['data'];
    if (list is! List) return const [];
    return list.whereType<Map>().map((e) => Camera.fromJson(e.cast<String, dynamic>())).toList();
  }

  /// Current JPEG of one lens. [bust] makes each request unique so the picture refreshes.
  Uri previewUri(String cameraId, int channelNo, {int? bust}) =>
      uri('/cameras/$cameraId/preview', {'channel': '$channelNo', if (bust != null) 't': '$bust'});

  void close() => _http.close();
}
