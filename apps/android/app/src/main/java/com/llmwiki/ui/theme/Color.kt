package com.llmwiki.ui.theme

import androidx.compose.ui.graphics.Color

// Shared slate surfaces and teal accent from packages/ui/src/styles.css.
// Dark theme
val Bg = Color(0xFF11181C)
val Bg2 = Color(0xFF182126)
val FgDark = Color(0xFFE6EDF0)
val FgMuted = Color(0xFFA7B6BD)
val BorderDark = Color(0xFF33434B)

// Light theme
val BgLight = Color(0xFFF8FAFC)
val Bg2Light = Color(0xFFF1F5F9)
val FgLight = Color(0xFF1E293B)
val FgMutedLight = Color(0xFF475569)
val BorderLight = Color(0xFFE2E8F0)

// Shared accent — teal-blue
val Accent = Color(0xFF5EC4B6)
val AccentDark = Color(0xFF0F766E)
val AccentContainerDark = Color(0xFF163A36)
val AccentContainerLight = Color(0xFFE4F3F0)
val AccentOnContainerDark = Color(0xFFD0F2EB)
val AccentOnContainerLight = Color(0xFF134E4A)
val ErrorDark = Color(0xFFFFB4AB)
val ErrorContainerDark = Color(0xFF5F1B16)
val ErrorContainerLight = Color(0xFFFFDAD6)
val ErrorOnContainerDark = Color(0xFFFFDAD6)
val ErrorOnContainerLight = Color(0xFF410002)

// surfaceContainer tones derived from Bg/Bg2 — without these, AlertDialog /
// DropdownMenu / ModalBottomSheet fall back to baseline purple-tinted M3 neutrals
val SurfaceContainerLowestDark = Color(0xFF0C1215)
val SurfaceContainerLowDark = Color(0xFF182126)
val SurfaceContainerDark = Color(0xFF202B31)
val SurfaceContainerHighDark = Color(0xFF26343B)
val SurfaceContainerHighestDark = Color(0xFF2E3D45)
val SurfaceContainerLowestLight = Color(0xFFFFFFFF)
val SurfaceContainerLowLight = Color(0xFFFFFFFF)
val SurfaceContainerLight = Color(0xFFF1F5F9)
val SurfaceContainerHighLight = Color(0xFFEAF0F6)
val SurfaceContainerHighestLight = Color(0xFFE2E8F0)
