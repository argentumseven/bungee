package org.bungee.app

import android.app.KeyguardManager
import android.content.Context
import android.location.LocationManager
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONObject

/**
 * Observes Android's airplane-mode, location-services and location-permission state and records
 * every change as a sharing-history event, which the next approved sync sends to the server.
 *
 * This is observation only. Bungee does not change any of these settings and has no way to: Android
 * keeps them behind system-only permissions. It also cannot learn who or what changed a setting, so
 * each event records the circumstances instead (locked, screen on, network gone, sharing running)
 * and whether it was seen live or found after Bungee had not been running.
 */
object DeviceStateMonitor {
    private val limiter = DeviceEventLimiter()
    private const val STALE_SECONDS = 300L
    private fun prefs(context: Context) = context.getSharedPreferences("device-state", Context.MODE_PRIVATE)

    private fun <T> read(block: () -> T): T? = runCatching(block).getOrNull()

    fun snapshot(context: Context): DeviceSnapshot {
        val location = read { context.getSystemService(LocationManager::class.java) }
        return DeviceSnapshot(
            airplane = read { Settings.Global.getInt(context.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) != 0 },
            locationServices = read { checkNotNull(location).isLocationEnabled },
            gpsProvider = read { checkNotNull(location).isProviderEnabled(LocationManager.GPS_PROVIDER) },
            fineLocation = TelemetryService.hasLocation(context),
            backgroundLocation = TelemetryService.hasBackgroundLocation(context),
            locked = read { context.getSystemService(KeyguardManager::class.java).isDeviceLocked },
            interactive = read { context.getSystemService(PowerManager::class.java).isInteractive },
            network = read { ConnectionHealth.kind(context).let { if (it == "offline") "none" else it } },
        )
    }

    /**
     * Compares with the saved baseline and records what changed. [live] is true for a broadcast or
     * periodic check, false when run at service start, where a difference means the change happened
     * while Bungee was not running and its time is unknown. Safe to call from any thread.
     */
    @Synchronized fun check(context: Context, live: Boolean, sharing: Boolean): DeviceSnapshot {
        val now = System.currentTimeMillis() / 1000
        val current = snapshot(context)
        val store = prefs(context)
        val previous = read { store.getString("baseline", null)?.let(::JSONObject) }
        val held = mutableSetOf<String>()
        for (change in DeviceStateChanges.diff(previous, current, now, live, sharing)) {
            if (limiter.admit(now)) {
                limiter.takeSkipped().takeIf { it > 0 }?.let { change.detail.put("suppressed", it) }
                SharingHistory.recordDevice(context, change.reason, change.at, change.detail)
            } else {
                held += change.key
                if (live) limiter.skip()
            }
        }
        val next = DeviceStateChanges.baseline(previous, current, now, held)
        val unchanged = previous != null && listOf(DeviceStateChanges.AIRPLANE, DeviceStateChanges.LOCATION_SERVICES, DeviceStateChanges.GPS_PROVIDER, DeviceStateChanges.FINE_LOCATION, DeviceStateChanges.BACKGROUND_LOCATION)
            .all { previous.opt(it) == next.opt(it) } && now - previous.optLong("seen_at", 0) < STALE_SECONDS
        // A failed write can repeat an event after a restart; it never invents one.
        if (!unchanged) runCatching { store.edit().putString("baseline", next.toString()).commit() }
        return current
    }

    /** Current switches for the periodic delivery report; nothing here is a location. */
    fun addDelivery(context: Context, delivery: JSONObject): JSONObject {
        val state = snapshot(context)
        delivery.put("location_services", state.locationServices ?: JSONObject.NULL)
        delivery.put("airplane_mode", state.airplane ?: JSONObject.NULL)
        TelemetryService.gpsHealth.lastFixAt?.let { delivery.put("last_fix_at", it) }
        delivery.put("fix_failures", TelemetryService.gpsHealth.failures)
        return delivery
    }

    fun clear(context: Context) { runCatching { prefs(context).edit().clear().commit() } }
}
