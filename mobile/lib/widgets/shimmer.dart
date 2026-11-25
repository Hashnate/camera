import 'package:flutter/material.dart';

import '../theme.dart';

/// Loading layout wrapper: a light band sweeps across every [Bone] inside [child], all in step (each bone paints its
/// own slice of one band that spans the whole layout). Cards and text in between stay as they are. Shaped like the
/// content that is coming, so nothing jumps when it arrives. Still when the phone asks for less motion.
class Shimmer extends StatefulWidget {
  const Shimmer({super.key, required this.child});
  final Widget child;

  static ShimmerState? of(BuildContext context) => context.findAncestorStateOfType<ShimmerState>();

  @override
  State<Shimmer> createState() => ShimmerState();
}

class ShimmerState extends State<Shimmer> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));

  Listenable get changes => _c;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.of(context).disableAnimations) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  static const _light = (Color(0xFFE9E8E6), Color(0xFFF9F9F8));
  static const _dark = (Color(0xFF1F1C1A), Color(0xFF37322E));

  Color baseColor(bool onDark) => (onDark ? _dark : _light).$1;

  LinearGradient gradient(bool onDark) {
    final (base, light) = onDark ? _dark : _light;
    return LinearGradient(
      colors: [base, light, base],
      stops: const [0.4, 0.5, 0.6],
      begin: const Alignment(-1, -0.25),
      end: const Alignment(1, 0.25),
      transform: _Slide(_c.value),
    );
  }

  RenderBox? get _box {
    final ro = context.findRenderObject();
    return ro is RenderBox && ro.hasSize ? ro : null;
  }

  /// The layout's rectangle in the coordinates of [bone], or null before the first layout.
  Rect? areaFor(RenderBox bone) {
    final box = _box;
    if (box == null || !bone.attached) return null;
    final o = bone.localToGlobal(Offset.zero, ancestor: box);
    return Rect.fromLTWH(-o.dx, -o.dy, box.size.width, box.size.height);
  }

  @override
  Widget build(BuildContext context) => Semantics(label: 'Loading', container: true, child: widget.child);
}

class _Slide extends GradientTransform {
  const _Slide(this.t);
  final double t;

  @override
  Matrix4 transform(Rect bounds, {TextDirection? textDirection}) =>
      Matrix4.translationValues(bounds.width * (t * 2.4 - 1.2), 0, 0);
}

/// One grey block of a loading layout, inside a [Shimmer]. [onDark] for blocks on the black card.
class Bone extends StatefulWidget {
  const Bone({super.key, this.width, this.height = 12, this.radius = 6, this.onDark = false}) : circle = false;
  const Bone.circle(double size, {super.key, this.onDark = false})
      : width = size,
        height = size,
        radius = 0,
        circle = true;

  final double? width;
  final double height;
  final double radius;
  final bool circle;
  final bool onDark;

  @override
  State<Bone> createState() => _BoneState();
}

class _BoneState extends State<Bone> {
  Listenable? _changes;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _changes?.removeListener(_tick);
    _changes = Shimmer.of(context)?.changes;
    _changes?.addListener(_tick);
  }

  @override
  void dispose() {
    _changes?.removeListener(_tick);
    super.dispose();
  }

  void _tick() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final shimmer = Shimmer.of(context);
    final block = Container(
      width: widget.width,
      height: widget.height,
      decoration: BoxDecoration(
        color: shimmer?.baseColor(widget.onDark) ?? C.track,
        shape: widget.circle ? BoxShape.circle : BoxShape.rectangle,
        borderRadius: widget.circle ? null : BorderRadius.circular(widget.radius),
      ),
    );
    final ro = context.findRenderObject();
    final area = shimmer != null && ro is RenderBox && ro.hasSize ? shimmer.areaFor(ro) : null;
    if (area == null) return block;
    return ShaderMask(
      blendMode: BlendMode.srcATop,
      shaderCallback: (_) => shimmer!.gradient(widget.onDark).createShader(area),
      child: block,
    );
  }
}

/// White card for loading layouts, the same shape as Panel.
class BoneCard extends StatelessWidget {
  const BoneCard({super.key, required this.child, this.padding = const EdgeInsets.all(16)});
  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20), boxShadow: C.shadow),
        child: child,
      );
}
