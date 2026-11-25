package org.bungee.app

import org.json.JSONObject

/**
 * What Android reported about radios and location at one moment. A null flag means Android
 * would not say; it is never guessed. Nothing here is a coordinate, network name or identifier.
 */
data class DeviceSnapshot(
    val airplane: Boolean?,
    val locationServices: Boolean?,
    val gpsProvider: Boolean?,
    val fineLocation: Boolean,
    val backgroundLocation: Boolean,
    val locked: Boolean?,
    val interactive: Boolean?,
    val network: String?,
)

/** One observed change, ready to be recorded and later reported. [key] names the baseline field. */
data class DeviceChange(val key: String, val reason: SharingReason, val at: Long?, val detail: JSONObject)

/**
 * Compares the last recorded baseline with the current snapshot. Android never tells an app who
 * or what changed airplane mode or location, so the evidence recorded is the circumstances: was
 * the phone locked, was the screen on, had the network gone, was sharing running, and whether
 * the change was seen as it happened or only found after Bungee had not been running.
 */
object DeviceStateChanges {
    const val AIRPLANE = "airplane"
    const val LOCATION_SERVICES = "location_services"
    const val GPS_PROVIDER = "gps_provider"
    const val FINE_LOCATION = "fine_location"
    const val BACKGROUND_LOCATION = "background_location"

    fun baseline(previous: JSONObject?, current: DeviceSnapshot, seenAt: Long, held: Set<String> = emptySet()): JSONObject {
        val next = JSONObject().put("seen_at", seenAt)
        fun carry(key: String, value: Boolean?) {
            // A change whose event was held back keeps its old baseline so a later check still reports it.
            val old = if (key in held) previous?.takeIf { it.has(key) }?.getBoolean(key) else null
            val chosen = old ?: value ?: previous?.takeIf { it.has(key) }?.getBoolean(key)
            if (chosen != null) next.put(key, chosen)
        }
        carry(AIRPLANE, current.airplane)
        carry(LOCATION_SERVICES, current.locationServices)
        carry(GPS_PROVIDER, current.gpsProvider)
        carry(FINE_LOCATION, current.fineLocation)
        carry(BACKGROUND_LOCATION, current.backgroundLocation)
        return next
    }

    fun context(current: DeviceSnapshot, live: Boolean, since: Long?, sharing: Boolean, suppressed: Int = 0): JSONObject = JSONObject().apply {
        put("source", if (live) "live" else "reconciled")
        if (!live && since != null && since > 0) put("since", since)
        current.airplane?.let { put("airplane", it) }
        current.locationServices?.let { put("location_services", it) }
        current.gpsProvider?.let { put("gps_provider", it) }
        put("fine_location", current.fineLocation)
        put("background_location", current.backgroundLocation)
        current.locked?.let { put("locked", it) }
        current.interactive?.let { put("interactive", it) }
        put("sharing", sharing)
        current.network?.let { put("network", it) }
        if (suppressed > 0) put("suppressed", suppressed.coerceAtMost(1_000_000))
    }

    /** No baseline means first run: nothing to compare, so nothing is claimed. */
    fun diff(previous: JSONObject?, current: DeviceSnapshot, now: Long, live: Boolean, sharing: Boolean, suppressed: Int = 0): List<DeviceChange> {
        val old = previous ?: return emptyList()
        val since = old.optLong("seen_at", 0).takeIf { it > 0 }
        val detail = { context(current, live, since, sharing, suppressed) }
        val at = if (live) now else null
        val changes = mutableListOf<DeviceChange>()
        fun differs(key: String, value: Boolean?) = value != null && old.has(key) && old.getBoolean(key) != value
        fun add(key: String, value: Boolean, whenTrue: SharingReason, whenFalse: SharingReason) {
            changes += DeviceChange(key, if (value) whenTrue else whenFalse, at, detail())
        }
        current.airplane?.takeIf { differs(AIRPLANE, it) }?.let { add(AIRPLANE, it, SharingReason.AIRPLANE_MODE_ON, SharingReason.AIRPLANE_MODE_OFF) }
        current.locationServices?.takeIf { differs(LOCATION_SERVICES, it) }?.let { add(LOCATION_SERVICES, it, SharingReason.LOCATION_SERVICES_ON, SharingReason.LOCATION_SERVICES_OFF) }
        // A disabled GPS provider is only news while the master switch stayed on; with the master off it follows it.
        val masterStayedOn = current.locationServices == true && (!old.has(LOCATION_SERVICES) || old.getBoolean(LOCATION_SERVICES))
        if (masterStayedOn) current.gpsProvider?.takeIf { differs(GPS_PROVIDER, it) }?.let { add(GPS_PROVIDER, it, SharingReason.GPS_PROVIDER_ON, SharingReason.GPS_PROVIDER_OFF) }
        val fineChanged = differs(FINE_LOCATION, current.fineLocation)
        if (fineChanged) add(FINE_LOCATION, current.fineLocation, SharingReason.LOCATION_PERMISSION_RESTORED, SharingReason.LOCATION_PERMISSION_LOST)
        // Background access cannot outlive precise access, so losing the latter already explains it.
        if (!fineChanged && current.fineLocation && differs(BACKGROUND_LOCATION, current.backgroundLocation))
            add(BACKGROUND_LOCATION, current.backgroundLocation, SharingReason.BACKGROUND_LOCATION_RESTORED, SharingReason.BACKGROUND_LOCATION_LOST)
        return changes
    }
}

/**
 * A flapping switch must not crowd out the phone's bounded queue. At most [limit] changes are
 * admitted per [windowSeconds]; a held-back change is not forgotten, because its baseline is not
 * advanced, and the next admitted event reports how many live notifications were skipped.
 */
class DeviceEventLimiter(private val limit: Int = 12, private val windowSeconds: Long = 600) {
    private val admitted = ArrayDeque<Long>()
    private var skipped = 0
    @Synchronized fun admit(now: Long): Boolean {
        while (admitted.isNotEmpty() && now - admitted.first() >= windowSeconds) admitted.removeFirst()
        if (admitted.size >= limit) return false
        admitted.addLast(now)
        return true
    }
    @Synchronized fun skip() { skipped = (skipped + 1).coerceAtMost(1_000_000) }
    /** Count of skipped notifications to attach to the next event; reading it resets it. */
    @Synchronized fun takeSkipped(): Int = skipped.also { skipped = 0 }
}

/**
 * Tracks whether GPS sampling is producing fixes. A gap is reported once, only when the phone
 * was genuinely waiting for satellites (permission and location services were available), and
 * ended once when fixes resume. Collection effort rises, within fixed bounds, while fixes fail:
 * a receiver without network assistance data may need longer than a normal window.
 */
class GpsCollectionHealth(
    private val reportAfterFailures: Int = 5,
    private val reportAfterSeconds: Long = 300,
) {
    var failures = 0; private set
    var lastFixAt: Long? = null; private set
    private var missingSince: Long? = null
    private var gapReported = false
    @Synchronized fun gapSeconds(now: Long): Long? = missingSince?.let { (now - it).coerceAtLeast(0) }
    /** Records a fix. Returns true when it ends a gap that was reported. */
    @Synchronized fun fix(now: Long): Boolean {
        val ended = gapReported
        failures = 0; missingSince = null; gapReported = false; lastFixAt = now
        return ended
    }
    /** Records a full attempt that waited and found nothing. Returns true once when the gap is worth reporting. */
    @Synchronized fun miss(now: Long): Boolean {
        failures = (failures + 1).coerceAtMost(1_000_000)
        if (missingSince == null) missingSince = lastFixAt?.takeIf { it <= now } ?: now
        if (!gapReported && failures >= reportAfterFailures && now - missingSince!! >= reportAfterSeconds) { gapReported = true; return true }
        return false
    }
    /** A listening window long enough for a receiver that must collect ephemeris from the satellites itself. */
    @Synchronized fun windowMillis(normal: Long): Long = if (failures > 0) maxOf(normal, EXTENDED_WINDOW) else normal
    /** Persistent failure backs off so a phone indoors does not hold the receiver on continuously. */
    @Synchronized fun spacingMillis(normal: Long): Long = if (failures >= BACK_OFF_AFTER) maxOf(normal, BACK_OFF_SPACING) else normal
    companion object {
        const val EXTENDED_WINDOW = 60_000L
        const val BACK_OFF_AFTER = 5
        const val BACK_OFF_SPACING = 180_000L
    }
}

/** Plain-language circumstances for an event, from its recorded detail. */
object DeviceStateText {
    fun context(detail: JSONObject?): String {
        if (detail == null) return ""
        val parts = mutableListOf<String>()
        if (detail.optString("source") == "reconciled") parts += "found changed after Bungee was not running; exact time unknown"
        if (detail.has("locked")) parts += if (detail.optBoolean("locked")) "phone was locked" else "phone was unlocked"
        if (detail.has("interactive")) parts += if (detail.optBoolean("interactive")) "screen on" else "screen off"
        if (detail.has("airplane") && detail.optBoolean("airplane")) parts += "airplane mode on"
        if (detail.has("location_services") && !detail.optBoolean("location_services")) parts += "location services off"
        if (detail.has("sharing")) parts += if (detail.optBoolean("sharing")) "Bungee sharing was running" else "Bungee sharing was not running"
        if (detail.optString("network") == "none") parts += "no network"
        detail.optInt("suppressed", 0).takeIf { it > 0 }?.let { parts += "$it more rapid changes not listed" }
        return parts.joinToString(" · ").replaceFirstChar { it.uppercase() }
    }
}
