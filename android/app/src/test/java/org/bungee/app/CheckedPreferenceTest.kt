package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class CheckedPreferenceTest {
    @Test fun failedCommitCannotAuthorizeFromSharedPreferencesInMemoryState() {
        val consent = CheckedPreference(failureValue = false)
        var memory = false
        var disk = false
        assertThrows(IllegalStateException::class.java) { consent.write { memory = true; false } }
        assertTrue(memory); assertFalse(disk)
        assertFalse(consent.read { memory })
        assertThrows(IllegalStateException::class.java) { consent.ifEnabled({ memory }) { error("Must not actuate") } }
        consent.write { memory = true; disk = true; true }
        assertTrue(consent.read { memory }); assertTrue(disk)
    }
    @Test fun failedWithdrawalVetoSurvivesDifferentIdentityReadersAndReadFailures() {
        val consent = CheckedPreference(failureValue = false)
        assertTrue(consent.read { true })
        assertThrows(IllegalStateException::class.java) { consent.write { false } }
        repeat(3) { assertFalse(consent.read { true }) }
        val unreadable = CheckedPreference(failureValue = false)
        assertFalse(unreadable.read { error("Damaged preferences") })
        assertFalse(unreadable.read { true })
    }
    @Test fun appLockFailureRemainsLockedUntilAConfirmedWrite() {
        val lock = CheckedPreference(failureValue = true)
        assertFalse(lock.read { false })
        assertThrows(IllegalStateException::class.java) { lock.write { false } }
        assertTrue(lock.read { false })
        lock.write { true }
        assertFalse(lock.read { false })
    }
    @Test fun exceptionsAndSuccessfulWithdrawalCannotPermitASideEffect() {
        val consent = CheckedPreference(failureValue = false)
        assertThrows(IllegalArgumentException::class.java) { consent.write { throw IllegalArgumentException("Storage fault") } }
        assertFalse(consent.read { true })
        var stored = true
        consent.write { stored = false; true }
        var effects = 0
        assertThrows(IllegalStateException::class.java) { consent.ifEnabled({ stored }) { effects++ } }
        assertEquals(0, effects)
    }
}
