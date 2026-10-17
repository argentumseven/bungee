package org.bungee.app

import android.view.Window
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.core.view.WindowInsetsControllerCompat

private val LightColors = lightColorScheme(
    primary = Color(0xFF2A6170), onPrimary = Color.White,
    primaryContainer = Color(0xFFE9F2F4), onPrimaryContainer = Color(0xFF194451),
    secondary = Color(0xFF356B60), onSecondary = Color.White,
    secondaryContainer = Color(0xFFEEF4F2), onSecondaryContainer = Color(0xFF254E44),
    background = Color(0xFFF5F7FA), onBackground = Color(0xFF273546),
    surface = Color.White, onSurface = Color(0xFF273546),
    surfaceVariant = Color(0xFFEEF2F6), onSurfaceVariant = Color(0xFF536475),
    outline = Color(0xFF536475), outlineVariant = Color(0xFFDCE4EC),
    error = Color(0xFF9E4343), onError = Color.White,
    errorContainer = Color(0xFFFFF1EF), onErrorContainer = Color(0xFF772F30),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFF96C5CF), onPrimary = Color(0xFF102F39),
    primaryContainer = Color(0xFF213742), onPrimaryContainer = Color(0xFFD4EDF1),
    secondary = Color(0xFF94BCB0), onSecondary = Color(0xFF132E28),
    secondaryContainer = Color(0xFF1D302F), onSecondaryContainer = Color(0xFFC0E2D5),
    background = Color(0xFF101720), onBackground = Color(0xFFE7EEF5),
    surface = Color(0xFF18222E), onSurface = Color(0xFFE7EEF5),
    surfaceVariant = Color(0xFF202C39), onSurfaceVariant = Color(0xFFA5B4C3),
    outline = Color(0xFF9AABBA), outlineVariant = Color(0xFF2E3C4C),
    error = Color(0xFFFFACA5), onError = Color(0xFF451D24),
    errorContainer = Color(0xFF39272D), onErrorContainer = Color(0xFFFFDAD5),
)

@Suppress("DEPRECATION") // Older supported Android versions still use these system-bar colors.
@Composable
fun BungeeTheme(mode: AppearanceMode, window: Window, content: @Composable () -> Unit) {
    val dark = when (mode) {
        AppearanceMode.SYSTEM -> isSystemInDarkTheme()
        AppearanceMode.LIGHT -> false
        AppearanceMode.DARK -> true
    }
    val colors = if (dark) DarkColors else LightColors
    SideEffect {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        window.statusBarColor = colors.background.toArgb()
        window.navigationBarColor = colors.background.toArgb()
    }
    MaterialTheme(colorScheme = colors, content = content)
}
