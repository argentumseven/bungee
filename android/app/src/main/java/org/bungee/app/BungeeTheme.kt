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
    primary = Color(0xFF6550C5), onPrimary = Color.White,
    primaryContainer = Color(0xFFEEEBFB), onPrimaryContainer = Color(0xFF39296D),
    secondary = Color(0xFF347554), onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDF5F0), onSecondaryContainer = Color(0xFF285D43),
    background = Color(0xFFF7F8FA), onBackground = Color(0xFF252B35),
    surface = Color.White, onSurface = Color(0xFF252B35),
    surfaceVariant = Color(0xFFF3F4F8), onSurfaceVariant = Color(0xFF687281),
    outline = Color(0xFF70798B), outlineVariant = Color(0xFFE2E5ED),
    error = Color(0xFF9E4343), onError = Color.White,
    errorContainer = Color(0xFFFFF1EF), onErrorContainer = Color(0xFF772F30),
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFFBAA7FF), onPrimary = Color(0xFF211839),
    primaryContainer = Color(0xFF2C2742), onPrimaryContainer = Color(0xFFE3DAFF),
    secondary = Color(0xFF92D0AE), onSecondary = Color(0xFF173527),
    secondaryContainer = Color(0xFF1D302B), onSecondaryContainer = Color(0xFFACDCBF),
    background = Color(0xFF10141E), onBackground = Color(0xFFE7E9F2),
    surface = Color(0xFF191F2C), onSurface = Color(0xFFE7E9F2),
    surfaceVariant = Color(0xFF212938), onSurfaceVariant = Color(0xFFA5AFC3),
    outline = Color(0xFF98A3BA), outlineVariant = Color(0xFF303A4E),
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
