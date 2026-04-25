package com.llmwiki.ui.theme

import androidx.compose.ui.graphics.Color

// Mirror of packages/ui/src/styles.css OKLCH tokens → hex (ARGB)
// Dark theme
val Bg = Color(0xFF0F1419)          // oklch(15% 0.015 250)
val Bg2 = Color(0xFF131A21)         // oklch(18% 0.015 250)
val FgDark = Color(0xFFE6E8EB)      // oklch(92% 0.01 250)
val FgMuted = Color(0xFF8892A0)     // oklch(65% 0.01 250)
val BorderDark = Color(0xFF242C36)  // oklch(25% 0.01 250)

// Light theme
val BgLight = Color(0xFFFAF9F7)     // oklch(98% 0.005 90)
val Bg2Light = Color(0xFFF3F1EE)    // oklch(96% 0.005 90)
val FgLight = Color(0xFF1C2128)     // oklch(20% 0.015 250)
val FgMutedLight = Color(0xFF57606A) // oklch(45% 0.015 250)
val BorderLight = Color(0xFFE6E3DC) // oklch(90% 0.005 90)

// Single accent (both themes) — soft violet
val Accent = Color(0xFFA78BFA)      // oklch(70% 0.15 295)
val AccentMuted = Color(0x66A78BFA) // accent @ 40% alpha
