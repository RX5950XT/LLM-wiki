package com.llmwiki.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import com.llmwiki.data.ThemeMode

// Rounder than M3 defaults: menus/fields were 4dp and read as sharp next to the 28dp dialogs.
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(12.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

private val DarkColorScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF082F2A),
    primaryContainer = AccentContainerDark,
    onPrimaryContainer = AccentOnContainerDark,
    secondary = FgMuted,
    onSecondary = Bg,
    secondaryContainer = SurfaceContainerDark,
    onSecondaryContainer = FgDark,
    error = ErrorDark,
    errorContainer = ErrorContainerDark,
    onErrorContainer = ErrorOnContainerDark,
    background = Bg,
    onBackground = FgDark,
    surface = Bg2,
    onSurface = FgDark,
    surfaceVariant = SurfaceContainerDark,
    onSurfaceVariant = FgMuted,
    outline = FgMuted,
    outlineVariant = BorderDark,
    surfaceContainerLowest = SurfaceContainerLowestDark,
    surfaceContainerLow = SurfaceContainerLowDark,
    surfaceContainer = SurfaceContainerDark,
    surfaceContainerHigh = SurfaceContainerHighDark,
    surfaceContainerHighest = SurfaceContainerHighestDark,
)

private val LightColorScheme = lightColorScheme(
    primary = AccentDark,
    onPrimary = Color.White,
    primaryContainer = AccentContainerLight,
    onPrimaryContainer = AccentOnContainerLight,
    secondary = FgMutedLight,
    onSecondary = Color.White,
    secondaryContainer = Bg2Light,
    onSecondaryContainer = FgLight,
    errorContainer = ErrorContainerLight,
    onErrorContainer = ErrorOnContainerLight,
    background = BgLight,
    onBackground = FgLight,
    surface = Color.White,
    onSurface = FgLight,
    surfaceVariant = Bg2Light,
    onSurfaceVariant = FgMutedLight,
    outline = FgMutedLight,
    outlineVariant = BorderLight,
    surfaceContainerLowest = SurfaceContainerLowestLight,
    surfaceContainerLow = SurfaceContainerLowLight,
    surfaceContainer = SurfaceContainerLight,
    surfaceContainerHigh = SurfaceContainerHighLight,
    surfaceContainerHighest = SurfaceContainerHighestLight,
)

@Composable
fun LlmWikiTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    dynamicColor: Boolean = false, // disabled — use our brand palette
    content: @Composable () -> Unit,
) {
    val darkTheme = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
    }

    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        shapes = AppShapes,
        typography = LlmWikiTypography,
        content = content,
    )
}
