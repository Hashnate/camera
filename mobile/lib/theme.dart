import 'package:flutter/material.dart';

/// Same palette as the website (Tailwind slate / blue / emerald / amber / rose).
class C {
  static const ink = Color(0xFF0F172A); // slate-900
  static const text = Color(0xFF334155); // slate-700
  static const muted = Color(0xFF64748B); // slate-500
  static const faint = Color(0xFF94A3B8); // slate-400
  static const line = Color(0xFFE2E8F0); // slate-200
  static const track = Color(0xFFF1F5F9); // slate-100
  static const bg = Color(0xFFF6F7F9);
  static const blue = Color(0xFF2563EB);
  static const blueSoft = Color(0xFFEFF6FF);
  static const green = Color(0xFF10B981);
  static const greenText = Color(0xFF047857);
  static const greenSoft = Color(0xFFECFDF5);
  static const amber = Color(0xFFF59E0B);
  static const amberLight = Color(0xFFFCD34D);
  static const amberText = Color(0xFF92400E);
  static const amberSoft = Color(0xFFFFFBEB);
  static const rose = Color(0xFFE11D48);
  static const roseText = Color(0xFFBE123C);
  static const roseSoft = Color(0xFFFFF1F2);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: C.blue, primary: C.ink, surface: Colors.white);
  final border =
      OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: C.line));
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: C.bg,
    appBarTheme: const AppBarTheme(
      backgroundColor: C.bg,
      foregroundColor: C.ink,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      centerTitle: false,
      titleTextStyle: TextStyle(color: C.ink, fontSize: 19, fontWeight: FontWeight.w600),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(borderSide: const BorderSide(color: C.blue, width: 2)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: C.ink,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
    ),
    navigationBarTheme:
        const NavigationBarThemeData(backgroundColor: Colors.white, indicatorColor: C.track, elevation: 1),
    dividerTheme: const DividerThemeData(color: C.track, space: 1, thickness: 1),
  );
}
