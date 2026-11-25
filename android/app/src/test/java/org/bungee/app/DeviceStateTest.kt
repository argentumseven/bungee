package org.bungee.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DeviceStateTest {
    private fun snapshot(
        airplane: Boolean? = false, services: Boolean? = true, provider: Boolean? = true,
        fine: Boolean = true, background: Boolean = true, locked: Boolean? = false, interactive: Boolean? = true, network: String? = "wifi",
    ) = DeviceSnapshot(airplane, services, provider, fine, background, locked, interactive, network)
    private fun baseline(current: DeviceSnapshot, seenAt: Long = 1_000) = DeviceStateChanges.baseline(null, current, seenAt)

    @Test fun firstRunClaimsNothing() {
        assertTrue(DeviceStateChanges.diff(null, snapshot(), 2_000, live = true, sharing = true).isEmpty())
        assertEquals(setOf("seen_at", "airplane", "location_services", "gps_provider", "fine_location", "background_location"), baseline(snapshot()).keys().asSequence().toSet())
    }
    @Test fun airplaneModeRecordsTheCircumstancesNotAnInventedCause() {
        val before = baseline(snapshot())
        val after = snapshot(airplane = true, locked = true, interactive = false, network = "none")
        val change = DeviceStateChanges.diff(before, after, 2_000, live = true, sharing = true).single()
        assertEquals(SharingReason.AIRPLANE_MODE_ON, change.reason)
        assertEquals(2_000L, change.at)
        assertEquals("live", change.detail.getString("source"))
        assertTrue(change.detail.getBoolean("locked")); assertFalse(change.detail.getBoolean("interactive"))
        assertEquals("none", change.detail.getString("network")); assertTrue(change.detail.getBoolean("sharing"))
        assertFalse(change.detail.has("since"))
        val off = DeviceStateChanges.diff(baseline(after), snapshot(), 2_100, live = true, sharing = true).single()
        assertEquals(SharingReason.AIRPLANE_MODE_OFF, off.reason)
    }
    @Test fun noChangeMeansNoEventEvenWhenContextChanges() {
        val before = baseline(snapshot(locked = false))
        assertTrue(DeviceStateChanges.diff(before, snapshot(locked = true, interactive = false, network = "cellular"), 2_000, live = true, sharing = true).isEmpty())
    }
    @Test fun locationServicesOffWhileAirplaneIsOnKeepsBothFacts() {
        val before = baseline(snapshot(airplane = true))
        val change = DeviceStateChanges.diff(before, snapshot(airplane = true, services = false, provider = false), 2_000, live = true, sharing = true).single()
        assertEquals(SharingReason.LOCATION_SERVICES_OFF, change.reason)
        assertTrue(change.detail.getBoolean("airplane")); assertFalse(change.detail.getBoolean("location_services"))
    }
    @Test fun gpsProviderChangesAreOnlyNewsWhileTheMasterSwitchStaysOn() {
        val before = baseline(snapshot())
        assertEquals(SharingReason.GPS_PROVIDER_OFF, DeviceStateChanges.diff(before, snapshot(provider = false), 2_000, true, true).single().reason)
        // The provider following the master switch down is not a second event.
        assertEquals(listOf(SharingReason.LOCATION_SERVICES_OFF), DeviceStateChanges.diff(before, snapshot(services = false, provider = false), 2_000, true, true).map { it.reason })
        // Master back on with the provider back on is one event as well.
        val off = baseline(snapshot(services = false, provider = false))
        assertEquals(listOf(SharingReason.LOCATION_SERVICES_ON), DeviceStateChanges.diff(off, snapshot(), 2_000, true, true).map { it.reason })
    }
    @Test fun losingPreciseAccessExplainsLosingBackgroundAccess() {
        val before = baseline(snapshot())
        assertEquals(listOf(SharingReason.LOCATION_PERMISSION_LOST), DeviceStateChanges.diff(before, snapshot(fine = false, background = false), 2_000, true, true).map { it.reason })
        assertEquals(listOf(SharingReason.BACKGROUND_LOCATION_LOST), DeviceStateChanges.diff(before, snapshot(background = false), 2_000, true, true).map { it.reason })
        val none = baseline(snapshot(fine = false, background = false))
        assertEquals(listOf(SharingReason.LOCATION_PERMISSION_RESTORED), DeviceStateChanges.diff(none, snapshot(), 2_000, true, true).map { it.reason })
    }
    @Test fun anUnreadableSettingIsNeverTreatedAsAChange() {
        val before = baseline(snapshot())
        assertTrue(DeviceStateChanges.diff(before, snapshot(airplane = null, services = null, provider = null), 2_000, true, true).isEmpty())
        val next = DeviceStateChanges.baseline(before, snapshot(airplane = null), 2_000)
        assertFalse(next.getBoolean("airplane")) // keeps the last known value
    }
    @Test fun aChangeFoundAtStartupHasNoTimeAndSaysWhenItWasLastKnownGood() {
        val before = baseline(snapshot(), seenAt = 900)
        val change = DeviceStateChanges.diff(before, snapshot(airplane = true), 5_000, live = false, sharing = true).single()
        assertNull(change.at)
        assertEquals("reconciled", change.detail.getString("source")); assertEquals(900L, change.detail.getLong("since"))
        // The journal accepts this shape and no other kind of missing time.
        val event = SharingEvent.create(change.reason, 5_000, change.at, change.detail)
        val parsed = SharingEvent.parse(JSONObject(event.json(local = true).toString()))
        assertNull(parsed.at); assertEquals("reconciled", parsed.detail!!.getString("source"))
        assertThrows(IllegalArgumentException::class.java) { SharingEvent.parse(SharingEvent.create(change.reason, 5_000, null, DeviceStateChanges.context(snapshot(), true, null, true)).json()) }
        assertThrows(IllegalArgumentException::class.java) { SharingEvent.parse(SharingEvent.create(SharingReason.USER_STOP, 5_000, null, change.detail).json()) }
        assertThrows(IllegalArgumentException::class.java) { SharingEvent.parse(SharingEvent.create(SharingReason.USER_STOP, 5_000, 5_000, change.detail).json()) }
    }
    @Test fun aHeldBackChangeKeepsItsOldBaselineSoItIsReportedLater() {
        val before = baseline(snapshot())
        val now = snapshot(airplane = true, services = false, provider = false)
        val next = DeviceStateChanges.baseline(before, now, 2_000, held = setOf(DeviceStateChanges.AIRPLANE))
        assertFalse(next.getBoolean("airplane")); assertFalse(next.getBoolean("location_services"))
        assertEquals(listOf(SharingReason.AIRPLANE_MODE_ON), DeviceStateChanges.diff(next, snapshot(airplane = true, services = false, provider = false), 2_100, true, true).map { it.reason })
    }
    @Test fun detailNeverContainsAnythingOutsideTheFixedVocabulary() {
        val allowed = setOf("source", "since", "airplane", "location_services", "gps_provider", "fine_location", "background_location", "locked", "interactive", "sharing", "network", "suppressed", "failures", "minutes")
        val detail = DeviceStateChanges.context(snapshot(airplane = true, locked = true), live = false, since = 5, sharing = true, suppressed = 3)
        assertTrue(allowed.containsAll(detail.keys().asSequence().toSet()))
        assertEquals(3, detail.getInt("suppressed"))
    }
    @Test fun aFlappingSwitchIsLimitedAndReportsHowMuchWasSkipped() {
        val limiter = DeviceEventLimiter(limit = 3, windowSeconds = 100)
        assertTrue(limiter.admit(0) && limiter.admit(1) && limiter.admit(2))
        assertFalse(limiter.admit(3)); limiter.skip(); assertFalse(limiter.admit(50)); limiter.skip()
        assertTrue(limiter.admit(101)) // the first admission has aged out
        assertEquals(2, limiter.takeSkipped()); assertEquals(0, limiter.takeSkipped())
    }
    @Test fun aGpsGapIsReportedOnceAndEndedOnce() {
        val health = GpsCollectionHealth(reportAfterFailures = 3, reportAfterSeconds = 120)
        var now = 1_000L
        assertFalse(health.fix(now)); assertEquals(0, health.failures)
        assertFalse(health.miss(now + 60)); assertFalse(health.miss(now + 120))
        assertTrue("third miss after two minutes is worth reporting", health.miss(now + 180))
        assertFalse("reported only once", health.miss(now + 240))
        assertEquals(4, health.failures); assertEquals(240L, health.gapSeconds(now + 240))
        assertTrue(health.fix(now + 300)); assertFalse(health.fix(now + 360))
        assertEquals(0, health.failures); assertNull(health.gapSeconds(now + 400))
        now = 5_000
        assertFalse("a short failure streak is not a gap", health.miss(now))
    }
    @Test fun collectionEffortRisesWithinFixedBoundsWhileFixesFail() {
        val health = GpsCollectionHealth()
        assertEquals(25_000L, health.windowMillis(25_000)); assertEquals(60_000L, health.spacingMillis(60_000))
        health.miss(100)
        assertEquals(60_000L, health.windowMillis(25_000))
        assertEquals(60_000L, health.spacingMillis(60_000))
        repeat(4) { health.miss(100L + it) }
        assertEquals("persistent failure backs off instead of holding the receiver on", 180_000L, health.spacingMillis(60_000))
        assertEquals("never longer than a minute", 60_000L, health.windowMillis(60_000))
        health.fix(500)
        assertEquals(25_000L, health.windowMillis(25_000))
    }
    @Test fun eventContextIsPlainLanguage() {
        val text = DeviceStateText.context(DeviceStateChanges.context(snapshot(airplane = true, locked = true, interactive = false, network = "none"), live = true, since = null, sharing = true))
        assertEquals("Phone was locked · screen off · airplane mode on · Bungee sharing was running · no network", text)
        assertTrue(DeviceStateText.context(JSONObject().put("source", "reconciled")).startsWith("Found changed after Bungee was not running"))
        assertEquals("", DeviceStateText.context(null))
    }
    @Test fun locationServicesOffIsItsOwnReportedState() {
        assertEquals("location_services_off", LocationAccess.describe(true, true, true, true, androidLocationOn = false))
        assertEquals("permission_denied", LocationAccess.describe(false, true, true, true, androidLocationOn = false))
        assertEquals("disabled", LocationAccess.describe(true, true, false, true, androidLocationOn = false))
        assertEquals("background", LocationAccess.describe(true, true, true, true))
    }
}
