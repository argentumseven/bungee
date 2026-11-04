package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class LegacyDnsCleanupTest {
    private val automatic = LegacyDnsSettings("opportunistic", null)
    private val strict = LegacyDnsSettings("hostname", "phone.dns.example.org")
    private val previous = LegacyDnsSettings("hostname", "previous.example.org")
    private class Store(var state: LegacyDnsState) : LegacyDnsStore {
        var cleared = false
        override fun read() = state
        override fun markRestoring() { state = state.copy(status = "restoring") }
        override fun clear() { cleared = true }
    }
    private class Settings(var value: LegacyDnsSettings, var allowed: Boolean = true) : LegacyDnsSettingsAccess {
        var writes = 0
        var fail = false
        var confirm = true
        override fun permitted() = allowed
        override fun read() = value
        override fun write(value: LegacyDnsSettings) { writes++; check(!fail); if (confirm) this.value = value }
    }
    @Test fun restoresStrictFallbackAndInterruptedWrites() {
        for ((status, current) in listOf("active" to strict, "fallback" to automatic,
            "error" to automatic, "error" to LegacyDnsSettings("opportunistic", strict.hostname),
            "fallback_pending" to automatic)) {
            val store = Store(LegacyDnsState(true, strict.hostname!!, status, previous))
            val settings = Settings(current)
            LegacyDnsCleanup(store, settings).restore()
            assertEquals(previous, settings.value); assertTrue(store.cleared)
        }
    }
    @Test fun restoresUnsetBaselineExactlyAndDefaultsMissingBaselineToAutomatic() {
        for (baseline in listOf(null, LegacyDnsSettings(null, null))) {
            val store = Store(LegacyDnsState(true, strict.hostname!!, "active", baseline))
            val settings = Settings(strict)
            LegacyDnsCleanup(store, settings).restore()
            assertEquals(baseline ?: automatic, settings.value); assertTrue(store.cleared)
        }
    }
    @Test fun preservesManualChangesEvenWithoutPermission() {
        for (status in listOf("active", "fallback", "error", "fallback_pending")) {
            val store = Store(LegacyDnsState(true, strict.hostname!!, status, previous))
            val settings = Settings(LegacyDnsSettings("off", null), false)
            LegacyDnsCleanup(store, settings).restore()
            assertEquals(0, settings.writes); assertTrue(store.cleared)
        }
    }
    @Test fun keepsUndoOnDeniedFailedOrUnconfirmedRestoration() {
        for (failure in listOf("denied", "write", "confirm")) {
            val store = Store(LegacyDnsState(true, strict.hostname!!, "active", previous))
            val settings = Settings(strict, failure != "denied").apply { fail = failure == "write"; confirm = failure != "confirm" }
            assertThrows(IllegalStateException::class.java) { LegacyDnsCleanup(store, settings).restore() }
            assertFalse(store.cleared)
            settings.allowed = true; settings.fail = false; settings.confirm = true
            LegacyDnsCleanup(store, settings).restore()
            assertEquals(previous, settings.value); assertTrue(store.cleared)
        }
    }
    @Test fun retriesPartiallyCompletedRestorationWithItsOriginalUndoRecord() {
        val store = Store(LegacyDnsState(true, strict.hostname!!, "active", previous))
        var current = strict
        var interrupted = true
        val settings = object : LegacyDnsSettingsAccess {
            override fun permitted() = true
            override fun read() = current
            override fun write(value: LegacyDnsSettings) {
                if (interrupted) { current = LegacyDnsSettings("opportunistic", value.hostname); error("interrupted") }
                current = value
            }
        }
        assertThrows(IllegalStateException::class.java) { LegacyDnsCleanup(store, settings).restore() }
        assertFalse(store.cleared); assertEquals("restoring", store.state.status)
        interrupted = false
        LegacyDnsCleanup(store, settings).restore()
        assertEquals(previous, current); assertTrue(store.cleared)
    }
    @Test fun unconfiguredPhoneNeverTouchesAndroidSettings() {
        val store = Store(LegacyDnsState(false, "", "disabled", null))
        val settings = Settings(previous, false)
        LegacyDnsCleanup(store, settings).restore()
        assertEquals(0, settings.writes); assertEquals(previous, settings.value); assertTrue(store.cleared)
    }
}
