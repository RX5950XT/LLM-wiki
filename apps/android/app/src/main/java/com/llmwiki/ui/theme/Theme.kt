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

private val DarkColorScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Bg,
    primaryContainer = AccentMuted,
    background = Bg,
    onBackground = FgDark,
    surface = Bg2,
    onSurface = FgDark,
    surfaceVariant = Bg2,
    onSurfaceVariant = FgMuted,
    outline = BorderDark,
)

private val LightColorScheme = lightColorScheme(
    primary = Accent,
    onPrimary = BgLight,
    primaryContainer = AccentMuted,
    background = BgLight,
    onBackground = FgLight,
    surface = Bg2Light,
    onSurface = FgLight,
    surfaceVariant = Bg2Light,
    onSurfaceVariant = FgMutedLight,
    outline = BorderLight,
)

@Composable
fun LlmWikiTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false, // disabled — use our brand palette
    content: @Composable () -> Unit,
) {
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
