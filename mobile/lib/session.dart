import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'api/api_client.dart';
import 'api/models.dart';

/// Who is signed in, to which server. The token lives in the phone's secure storage (Keychain / Keystore).
class Session extends ChangeNotifier {
  Session({FlutterSecureStorage? storage, this.httpClient}) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  /// Tests pass a fake; the app uses a real one per server.
  final http.Client? httpClient;
  static const _kServer = 'server';
  static const _kToken = 'token';
  static const _kEmail = 'email';

  bool restoring = true;

  /// Set when a saved sign-in couldn't be checked because the server was unreachable.
  String? restoreError;

  /// Shown once on the sign-in screen, e.g. "Your sign-in expired".
  String? notice;

  /// Pre-fills the sign-in form.
  String? lastServer;
  String? lastEmail;

  ApiClient? _api;
  SessionUser? user;

  bool get signedIn => _api != null && user != null;
  ApiClient get api => _api!;

  ApiClient _client(String server, String? token) =>
      ApiClient(server, token: token, httpClient: httpClient)..onUnauthorized = _expired;

  void _expired() {
    if (!signedIn) return;
    signOut(notice: 'Your sign-in expired. Please sign in again.');
  }

  Future<void> restore() async {
    restoring = true;
    restoreError = null;
    notifyListeners();
    try {
      lastServer = await _storage.read(key: _kServer);
      lastEmail = await _storage.read(key: _kEmail);
      final token = await _storage.read(key: _kToken);
      if (lastServer != null && token != null) {
        final client = _client(lastServer!, token);
        try {
          final me = await client.me();
          if (me.isManager) {
            _api = client;
            user = me;
          } else {
            await _storage.delete(key: _kToken);
          }
        } on ApiException catch (e) {
          if (e.unauthorized) {
            await _storage.delete(key: _kToken);
            notice = 'Your sign-in expired. Please sign in again.';
          } else {
            restoreError = e.message;
          }
        }
      }
    } catch (_) {
      // Unreadable secure storage (e.g. restored backup on a new phone): start signed out.
      try {
        await _storage.deleteAll();
      } catch (_) {}
    }
    restoring = false;
    notifyListeners();
  }

  /// Throws [ApiException] with a message the person can act on.
  Future<void> signIn({required String server, required String email, required String password}) async {
    final base = ApiClient.normalizeServer(server);
    if (base.isEmpty) {
      throw ApiException('Enter your WorkSight server address.');
    }
    final client = _client(base, null);

    final bool isWorkSight;
    try {
      isWorkSight = await client.isWorkSightServer();
    } on ApiException {
      throw ApiException("Can't reach a WorkSight server at $base. Check the address and your connection.");
    }
    if (!isWorkSight) throw ApiException('$base is not a WorkSight server.');

    final result = await client.login(email.trim(), password);
    if (!result.user.isManager) {
      client.token = result.token;
      await client.logout();
      throw ApiException('This app is for managers. Your account (${result.user.roleLabel}) can only use the website.');
    }
    if (result.user.mustChangePassword) {
      client.token = result.token;
      await client.logout();
      throw ApiException('Please set a new password on the website first ($base), then sign in here.');
    }

    client.token = result.token;
    await _storage.write(key: _kServer, value: base);
    await _storage.write(key: _kEmail, value: email.trim());
    await _storage.write(key: _kToken, value: result.token);
    lastServer = base;
    lastEmail = email.trim();
    _api = client;
    user = result.user;
    notice = null;
    restoreError = null;
    notifyListeners();
  }

  Future<void> signOut({String? notice}) async {
    final client = _api;
    _api = null;
    user = null;
    restoreError = null;
    this.notice = notice;
    await _storage.delete(key: _kToken);
    notifyListeners();
    if (client != null && notice == null) await client.logout();
    if (httpClient == null) client?.close();
  }
}

/// Makes the [Session] available to every screen.
class SessionScope extends InheritedNotifier<Session> {
  const SessionScope({super.key, required Session session, required super.child}) : super(notifier: session);

  /// Rebuilds the caller when the session changes.
  static Session of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<SessionScope>()!.notifier!;

  /// For callbacks (no rebuild).
  static Session read(BuildContext context) => context.getInheritedWidgetOfExactType<SessionScope>()!.notifier!;
}
