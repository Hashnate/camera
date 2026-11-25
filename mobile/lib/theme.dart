import 'package:flutter/material.dart';

/// Hashnate colours (black, white, orange #FF6600) with warm greys. The names below are what the screens use:
/// "amber" is the away / attention colour (orange), "blue" is the old website accent, now black.
class C {
  static const ink = Color(0xFF0A0A0A); // Hashnate black
  static const text = Color(0xFF44403C); // stone-700
  static const muted = Color(0xFF57534E); // stone-600: small grey text, readable on white and on bg
  static const subtle = Color(0xFF78716C); // stone-500: axis labels and other secondary text
  static const faint = Color(0xFFA8A29E); // stone-400: icons and decoration only, not for text
  static const line = Color(0xFFE7E5E4);
  static const track = Color(0xFFF0EFEE);
  static const bg = Color(0xFFF4F4F3);
  static const card = Colors.white;

  static const accent = Color(0xFFFF6600); // Hashnate orange: graphics, rings, highlights
  static const accentText = Color(0xFFC2410C); // orange that is readable as small text on white

  static const blue = ink;
  static const blueSoft = Color(0xFFF5F5F4);
  static const green = Color(0xFF16A34A);
  static const greenText = Color(0xFF166534);
  static const greenSoft = Color(0xFFDCFCE7);
  static const amber = accent;
  static const amberLight = Color(0xFFFDBA74);
  static const amberText = Color(0xFF9A3412);
  static const amberSoft = Color(0xFFFFEDD5);
  static const rose = Color(0xFFE11D48);
  static const roseText = Color(0xFFBE123C);
  static const roseSoft = Color(0xFFFFF1F2);

  /// Soft card shadow (cards have no border).
  static const shadow = [
    BoxShadow(color: Color(0x0A000000), blurRadius: 2, offset: Offset(0, 1)),
    BoxShadow(color: Color(0x0A000000), blurRadius: 18, offset: Offset(0, 6)),
  ];
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: C.accent, primary: C.ink, surface: Colors.white);
  final border =
      OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: C.line));
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: C.bg,
    appBarTheme: const AppBarTheme(
      backgroundColor: C.bg,
      foregroundColor: C.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(color: C.ink, fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -0.3),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(borderSide: const BorderSide(color: C.ink, width: 2)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: C.ink,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: C.ink,
        side: const BorderSide(color: C.line),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600),
      ),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: C.accentText)),
    chipTheme: ChipThemeData(
      backgroundColor: Colors.white,
      selectedColor: C.ink,
      side: const BorderSide(color: C.line),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      labelStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: C.text),
      secondaryLabelStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Colors.white),
      checkmarkColor: Colors.white,
      showCheckmark: false,
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: C.accent),
    textSelectionTheme: const TextSelectionThemeData(cursorColor: C.ink),
    dividerTheme: const DividerThemeData(color: C.track, space: 1, thickness: 1),
  );
}
