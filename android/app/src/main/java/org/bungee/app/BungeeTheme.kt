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
    primary = Color(0xFFC51353), onPrimary = Color.White,
    primaryContainer = Color(0xFFFDE8EF), onPrimaryContainer = Color(0xFF601C37),
    secondary = Color(0xFF347554), onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDF5F0), onSecondaryContainer = Color(0xFF285D43),
    background = Color(0xFFFFF8FA), onBackground = Color(0xFF30222B),
    surface = Color.White, onSurface = Color(0xFF30222B),
    surfaceVariant = Color(0xFFFAF0F4), onSurfaceVariant = Color(0xFF6F5B68),
    outline = Color(0xFF6F5B68), outlineVariant = Color(0xFFEADAE2),
    error = Color(0xFF9E4343), onError = Color.White,
    errorContainer = Color(0xFFFFF1EF), onErrorContainer = Color(0xFF772F30),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFFFF92B6), onPrimary = Color(0xFF35111F),
    primaryContainer = Color(0xFF3B2431), onPrimaryContainer = Color(0xFFFFD7E5),
    secondary = Color(0xFF92D0AE), onSecondary = Color(0xFF173527),
    secondaryContainer = Color(0xFF1D302B), onSecondaryContainer = Color(0xFFACDCBF),
    background = Color(0xFF141216), onBackground = Color(0xFFF5EDF2),
    surface = Color(0xFF1E1A20), onSurface = Color(0xFFF5EDF2),
    surfaceVariant = Color(0xFF282229), onSurfaceVariant = Color(0xFFB9A9B5),
    outline = Color(0xFFB3A2B0), outlineVariant = Color(0xFF40323D),
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
