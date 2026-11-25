import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import '../widgets/common.dart';
import '../widgets/shimmer.dart';

/// A current picture of every lens and its recognition state.
///
/// Pictures refresh every 3 s only when they are free: the lens is live in recognition (the server hands back the AI
/// service's latest frame) or the camera isn't an EZVIZ cloud camera. Otherwise a picture costs one call from the
/// EZVIZ account's daily allowance (1,000/day, shared with recognition), so it loads once and refreshes on tap.
class CamerasScreen extends StatefulWidget {
  const CamerasScreen({super.key, required this.active});
  final bool active;

  @override
  State<CamerasScreen> createState() => _CamerasScreenState();
}

class _CamerasScreenState extends State<CamerasScreen> with WidgetsBindingObserver {
  List<Camera>? _cameras;
  RecognitionStatus? _status;
  String? _error;
  Timer? _tick;
  bool _foreground = true;

  /// Per lens: changing it fetches a new picture.
  final Map<String, int> _bust = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Nothing is fetched until the tab is opened (the tabs are all built at start-up).
    if (widget.active) _load();
    _tick = Timer.periodic(const Duration(seconds: 3), (_) {
      final cams = _cameras;
      if (!widget.active || !_foreground || !mounted || cams == null) return;
      var changed = false;
      for (final cam in cams) {
        for (final lens in cam.lenses) {
          if (_isFree(cam, lens)) {
            _bust.update(_key(cam, lens), (v) => v + 1, ifAbsent: () => 1);
            changed = true;
          }
        }
      }
      if (changed) setState(() {});
    });
  }

  @override
  void didUpdateWidget(CamerasScreen old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) _load();
  }

  String _key(Camera cam, CameraLens lens) => '${cam.id}:${lens.channelNo}';

  bool _isFree(Camera cam, CameraLens lens) =>
      !cam.isEzviz || (_status?.channel(cam.id, lens.channelNo)?.running ?? false);

  void _refreshLens(Camera cam, CameraLens lens) =>
      setState(() => _bust.update(_key(cam, lens), (v) => v + 1, ifAbsent: () => 1));

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _foreground = state == AppLifecycleState.resumed;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    final api = SessionScope.read(context).api;
    final statusF = api.recognitionStatus();
    try {
      final cameras = await api.cameras();
      final status = await statusF;
      if (!mounted) return;
      setState(() {
        _cameras = cameras.where((c) => c.isEnabled).toList();
        _status = status;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cams = _cameras;
    final api = SessionScope.of(context).api;
    Widget lensBones() => const Padding(
          padding: EdgeInsets.only(bottom: 12),
          child: BoneCard(
            padding: EdgeInsets.zero,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              AspectRatio(aspectRatio: 16 / 9, child: Bone(radius: 0)),
              Padding(
                padding: EdgeInsets.fromLTRB(14, 12, 14, 14),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Bone(width: 150, height: 13),
                  SizedBox(height: 8),
                  Bone(width: 210, height: 10),
                ]),
              ),
            ]),
          ),
        );
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          color: C.accent,
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, kNavClearance),
            children: [
              const ScreenHeader(title: 'Cameras', subtitle: 'The current picture from each lens'),
              const SizedBox(height: 14),
              if (_error != null && cams == null)
                ErrorPanel(message: _error!, onRetry: _load)
              else if (cams == null)
                Shimmer(child: Column(children: [lensBones(), lensBones()]))
              else if (cams.isEmpty)
                const Panel(
                  child: EmptyState(
                      icon: Icons.videocam_off_outlined,
                      title: 'No cameras turned on',
                      message: 'Add or turn on a camera on the website, under Settings.'),
                )
              else
                for (final cam in cams)
                  for (final lens in cam.lenses) ...[
                    _LensCard(
                      camera: cam,
                      lens: lens,
                      status: _status?.channel(cam.id, lens.channelNo),
                      imageUri: api.previewUri(cam.id, lens.channelNo, bust: _bust[_key(cam, lens)] ?? 0),
                      headers: api.authHeaders,
                      autoRefresh: _isFree(cam, lens),
                      onRefresh: () => _refreshLens(cam, lens),
                    ),
                    const SizedBox(height: 12),
                  ],
            ],
          ),
        ),
      ),
    );
  }
}

class _LensCard extends StatelessWidget {
  const _LensCard({
    required this.camera,
    required this.lens,
    required this.status,
    required this.imageUri,
    required this.headers,
    required this.autoRefresh,
    required this.onRefresh,
  });
  final Camera camera;
  final CameraLens lens;
  final ChannelStatus? status;
  final Uri imageUri;
  final Map<String, String> headers;
  final bool autoRefresh;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final st = status;
    final (label, color) = !lens.recognitionEnabled
        ? ('Recognition off', C.faint)
        : st == null
            ? ('Not watched', C.faint)
            : switch (st.state) {
                'running' => ('Live', C.green),
                'error' => ('Error', C.rose),
                _ => ('Connecting', C.amber),
              };
    return Panel(
      padding: EdgeInsets.zero,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        AspectRatio(
          aspectRatio: 16 / 9,
          child: GestureDetector(
            onTap: onRefresh,
            child: Stack(fit: StackFit.expand, children: [
              ColoredBox(
                color: C.ink,
                child: Image.network(
                  imageUri.toString(),
                  headers: headers,
                  fit: BoxFit.contain,
                  gaplessPlayback: true, // keep the last picture while the next one loads
                  cacheWidth: 1280, // camera frames can be 4K; decode them at phone size
                  errorBuilder: (_, __, ___) => const Center(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Icon(Icons.videocam_off_outlined, color: Colors.white54),
                      SizedBox(height: 6),
                      Text('No picture right now', style: TextStyle(color: Colors.white60, fontSize: 12.5)),
                    ]),
                  ),
                ),
              ),
              Positioned(
                right: 8,
                bottom: 8,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(color: const Color(0xB3000000), borderRadius: BorderRadius.circular(99)),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(autoRefresh ? Icons.autorenew : Icons.touch_app_outlined, size: 13, color: Colors.white70),
                    const SizedBox(width: 4),
                    Text(autoRefresh ? 'Updating' : 'Tap for a new picture',
                        style: const TextStyle(fontSize: 11, color: Colors.white70)),
                  ]),
                ),
              ),
            ]),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(lens.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: C.ink)),
                Text(
                  [
                    camera.name,
                    if (camera.location != null && camera.location!.isNotEmpty) camera.location!,
                    if (st?.lastFrameAt != null) 'frame ${timeAgo(st!.lastFrameAt, DateTime.now())}'
                  ].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12, color: C.muted),
                ),
              ]),
            ),
            const SizedBox(width: 8),
            Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Text(label, style: const TextStyle(fontSize: 12.5, color: C.text)),
          ]),
        ),
      ]),
    );
  }
}
