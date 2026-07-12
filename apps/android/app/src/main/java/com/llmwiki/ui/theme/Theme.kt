package com.llmwiki.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.llmwiki.data.ThemeMode

private val DarkColorScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Bg,
    primaryContainer = AccentContainerDark,
    onPrimaryContainer = AccentOnContainerDark,
    secondaryContainer = BorderDark,
    onSecondaryContainer = FgDark,
    error = ErrorDark,
    errorContainer = ErrorContainerDark,
    onErrorContainer = ErrorOnContainerDark,
    background = Bg,
    onBackground = FgDark,
    surface = Bg2,
    onSurface = FgDark,
    surfaceVariant = Bg2,
    onSurfaceVariant = FgMuted,
    outline = BorderDark,
    surfaceContainerLowest = SurfaceContainerLowestDark,
    surfaceContainerLow = SurfaceContainerLowDark,
    surfaceContainer = SurfaceContainerDark,
    surfaceContainerHigh = SurfaceContainerHighDark,
    surfaceContainerHighest = SurfaceContainerHighestDark,
)

private val LightColorScheme = lightColorScheme(
    primary = AccentDark,
    onPrimary = BgLight,
    primaryContainer = AccentContainerLight,
    onPrimaryContainer = AccentOnContainerLight,
    secondaryContainer = Bg2Light,
    onSecondaryContainer = FgLight,
    errorContainer = ErrorContainerLight,
    onErrorContainer = ErrorOnContainerLight,
    background = BgLight,
    onBackground = FgLight,
    surface = Bg2Light,
    onSurface = FgLight,
    surfaceVariant = Bg2Light,
    onSurfaceVariant = FgMutedLight,
    outline = BorderLight,
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
        typography = LlmWikiTypography,
        content = content,
    )
}
