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

// Shared accent — teal-blue
val Accent = Color(0xFF5FD4E2)      // oklch(72% 0.14 205)
val AccentDark = Color(0xFF2C8CA7)  // stronger action tone
val AccentContainerDark = Color(0xFF11313C)
val AccentContainerLight = Color(0xFFDDF6F8)
val AccentOnContainerDark = Color(0xFFDCF7FB)
val AccentOnContainerLight = Color(0xFF0F3340)
val ErrorDark = Color(0xFFFFB4AB)
val ErrorContainerDark = Color(0xFF5F1B16)
val ErrorContainerLight = Color(0xFFFFDAD6)
val ErrorOnContainerDark = Color(0xFFFFDAD6)
val ErrorOnContainerLight = Color(0xFF410002)

// surfaceContainer tones derived from Bg/Bg2 — without these, AlertDialog /
// DropdownMenu / ModalBottomSheet fall back to baseline purple-tinted M3 neutrals
val SurfaceContainerLowestDark = Color(0xFF0B0F14)
val SurfaceContainerLowDark = Color(0xFF11171E)
val SurfaceContainerDark = Color(0xFF161E26)
val SurfaceContainerHighDark = Color(0xFF1B242E)
val SurfaceContainerHighestDark = Color(0xFF212B36)
val SurfaceContainerLowestLight = Color(0xFFFFFFFF)
val SurfaceContainerLowLight = Color(0xFFF7F5F2)
val SurfaceContainerLight = Color(0xFFF3F1EE)
val SurfaceContainerHighLight = Color(0xFFEDEAE6)
val SurfaceContainerHighestLight = Color(0xFFE7E4DF)
