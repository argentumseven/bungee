package org.bungee.app

import android.app.Activity
import android.content.Context

enum class AppearanceMode(val label: String) { SYSTEM("System"), LIGHT("Light"), DARK("Dark") }

/** Cosmetic preference only. Recovery never needs Identity, keys, or the tunnel to read it. */
object AppearancePreference {
    private const val FILE = "bungee_appearance"
    fun read(context: Context): AppearanceMode = runCatching {
        val stored = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString("mode", null)
        AppearanceMode.entries.firstOrNull { it.name == stored } ?: AppearanceMode.SYSTEM
    }.getOrDefault(AppearanceMode.SYSTEM)

    fun write(context: Context, mode: AppearanceMode): Boolean = runCatching {
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString("mode", mode.name).commit()
    }.getOrDefault(false)

    fun applyTo(activity: Activity) {
        activity.setTheme(when (read(activity)) {
            AppearanceMode.LIGHT -> R.style.Theme_Bungee_Light
            AppearanceMode.DARK -> R.style.Theme_Bungee_Dark
            AppearanceMode.SYSTEM -> R.style.Theme_Bungee
        })
    }
}
