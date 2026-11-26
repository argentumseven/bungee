package org.bungee.app

import android.Manifest
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/** Read-only checks. This does not request a location fix or exercise recovery hardware. */
object PhoneDiagnostics {
    fun collect(context: Context, identity: Identity, locationForeground: Boolean): JSONArray {
        val checks = JSONArray()
        fun add(label: String, detail: String, status: String = "info") {
            checks.put(JSONObject().put("label", label).put("status", status).put("detail", detail))
        }
        fun check(label: String, available: Boolean, pass: String, help: String) {
            add(label, if (available) pass else help, if (available) "ok" else "attention")
        }
        val location = context.getSystemService(LocationManager::class.java)
        val gps = location.isProviderEnabled(LocationManager.GPS_PROVIDER)
        val network = location.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        val locationEnabled = location.isLocationEnabled
        add("Android location services",
            if (locationEnabled) "On. Satellite provider: ${if (gps) "enabled" else "unavailable"}. Network provider: ${if (network) "enabled" else "unavailable"}."
            else "Off. Turn on Location in Android Settings before requesting a GPS fix.",
            if (locationEnabled && gps) "ok" else "attention")
        val precise = TelemetryService.hasLocation(context)
        val approximate = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        check("Bungee location access", precise, "Precise location is granted.",
            if (approximate) "Only approximate location is granted. Enable precise location in Bungee’s Android permissions."
            else "Location permission is denied. Grant precise location in Bungee’s Android permissions.")
        val background = TelemetryService.hasBackgroundLocation(context)
        check("Background GPS", background, "Location is allowed all the time.",
            if (locationForeground) "Bungee is using the foreground location service. Grant Allow all the time so GPS can resume after a restart."
            else "Background location is unavailable. Grant Allow all the time for temporary GPS while Bungee is in the background.")
        add("Automatic GPS sharing", if (identity.allowLocate) "Enabled on the phone." else "Off on the phone. Approved temporary GPS can still work with the required Android access.")
        val delivery = runCatching { identity.backlogReport() }.getOrNull()
        if (delivery == null) {
            add("Saved GPS delivery", "The local GPS queue could not be read. Check Bungee’s storage on the phone.", "attention")
        } else {
            val queued = delivery.optInt("queued_fixes")
            val dropped = delivery.optLong("dropped_fixes")
            add("Saved GPS delivery", "$queued fixes waiting on the phone. $dropped fixes discarded at local capacity.",
                if (dropped > 0) "attention" else "info")
        }

        val connection = ConnectionHealth.report(context)
        val transport = when (connection.optString("connection")) {
            "wifi" -> "Wi-Fi"
            "cellular" -> "Cellular"
            "vpn" -> "Android VPN"
            "ethernet" -> "Ethernet"
            else -> "Unknown network"
        }
        val rtt = connection.optLong("last_rtt_ms", -1)
        val probe = if (rtt >= 0) " Last signed poll took $rtt ms." else ""
        val signal = if (connection.isNull("signal_dbm")) "" else " Signal: ${connection.getInt("signal_dbm")} dBm."
        add("Server connection", "The phone received this authenticated request over $transport.$probe$signal", "ok")
        val power = context.getSystemService(PowerManager::class.java)
        val battery = context.getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val powerDetail = if (power.isPowerSaveMode) "Battery Saver is on." else "Battery Saver is off."
        add("Battery and power", if (battery in 0..100) "$battery% remaining. $powerDetail" else powerDetail,
            if (power.isPowerSaveMode || battery in 0..15) "attention" else "ok")
        add("Background activity", if (power.isIgnoringBatteryOptimizations(context.packageName)) "Bungee is exempt from Android battery optimization."
            else "Android battery optimization applies. It may delay background work.", "info")
        val space = context.filesDir.usableSpace / (1024 * 1024)
        check("Local storage", space >= 128, "$space MiB available to Bungee.", "$space MiB available. Free space for queued data and app updates.")
        val notifications = context.getSystemService(NotificationManager::class.java)
        val recoveryChannel = notifications.getNotificationChannel("recovery")
        check("Recovery notifications", notifications.areNotificationsEnabled() && recoveryChannel?.importance != NotificationManager.IMPORTANCE_NONE,
            "Bungee can show recovery notifications.", "Enable Bungee and its recovery notifications in Android Settings.")
        val admin = context.getSystemService(DevicePolicyManager::class.java).isAdminActive(ComponentName(context, BungeeAdminReceiver::class.java))
        add("Removable device administration", if (admin) "On. Android can accept screen-lock requests and report supported failed entries." else "Off. Screen locking and failed-entry detection are unavailable.")
        val camera = ArmedCameraService.status.value
        val cameraEnabled = LocalSafety.isCameraEnabled(context)
        val cameraPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        add("Theft-photo protection", when {
            camera.armed -> "Armed in the main profile."
            !cameraPermission -> "Camera permission is off in the main profile."
            cameraEnabled -> "Approved but currently unarmed. Check the main profile on the phone."
            else -> "Off in the main profile."
        }, if (cameraEnabled && !camera.armed) "attention" else "info")
        if (cameraEnabled) {
            val automaticBoot = LocalSafety.isCameraRestartAllowed(context)
            val startupAccess = CameraBootRecovery.hasStartupAccess(context)
            add("Automatic recovery after reboot", when {
                !automaticBoot -> "Off. Open Bungee in the main profile after a reboot to restore theft-photo protection."
                startupAccess -> "Approved with Android startup access."
                else -> "Approved. Grant Android startup access to restore theft-photo protection after first unlock."
            }, if (automaticBoot && !startupAccess) "attention" else "info")
        }
        add("App and Android", "Bungee ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} · security patch ${Build.VERSION.SECURITY_PATCH}.")
        return checks
    }
}
