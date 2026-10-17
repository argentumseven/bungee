package org.bungee.app

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class BootCameraGateTest {
    private class Fixture {
        var state = BootCameraState()
        var allowed = true
        var failWrite = false
        var launches = 0
        val gate = BootCameraGate({ state }, { if (failWrite) throw IOException("Full disk"); state = it })
        fun launch(key: String = "7:18", time: Long = 100) = gate.launch(key, time, { allowed }) { launches++ }
        fun consume(key: String = "7:18", time: Long = 101) = gate.consume(key, time) { allowed }
    }
    @Test fun deferredRequestLaunchesAtUnlockAndCanBeConsumedOnlyOnce() {
        val f = Fixture(); f.gate.request("7:18"); f.allowed = false
        assertFalse(f.launch()); assertEquals(0, f.launches)
        f.allowed = true
        assertTrue(f.launch()); assertEquals(1, f.launches)
        assertTrue(f.consume()); assertFalse(f.consume()); assertFalse(f.launch())
    }
    @Test fun failedPersistenceCannotShowTheStartupWindowOrAuthorizeAConsumption() {
        val f = Fixture(); f.gate.request("7:18"); f.failWrite = true
        assertThrows(IOException::class.java) { f.launch() }
        assertEquals(0, f.launches); assertNull(f.state.offered)
        f.failWrite = false; assertFalse(f.consume()); assertTrue(f.launch())
    }
    @Test fun aFailedWindowLaunchIsNotRepeatedByDuplicateBootOrUnlockEvents() {
        val f = Fixture(); f.gate.request("7:18")
        assertThrows(IOException::class.java) { f.gate.launch("7:18", 100, { true }) { throw IOException("Android denied startup") } }
        repeat(5) { f.gate.request("7:18"); assertFalse(f.launch()) }
        assertEquals("7:18", f.state.attempted)
    }
    @Test fun revocationBetweenClaimPersistenceAndWindowLaunchCancelsTheOffer() {
        var state = BootCameraState(pending = "7:18"); var allowed = true; var shown = false
        val gate = BootCameraGate({ state }, { state = it; if (it.offered != null) allowed = false })
        assertFalse(gate.launch("7:18", 100, { allowed }) { shown = true })
        assertFalse(shown); allowed = true
        assertFalse(gate.consume("7:18", 101) { allowed }); assertNull(state.offered)
    }
    @Test fun disarmingAndClearingPendingStateCannotResurrectAnOldOffer() {
        val f = Fixture(); f.gate.request("7:18"); assertTrue(f.launch())
        f.allowed = false; f.gate.cancel(); f.allowed = true
        assertFalse(f.consume()); assertFalse(f.launch()); assertEquals(1, f.launches)
    }
    @Test fun differentBootsVersionsAndExpiredOrReversedTimeCannotConsumeAnOffer() {
        for ((key, time) in listOf("8:18" to 101L, "7:19" to 101L, "7:18" to 30_101L, "7:18" to 99L)) {
            val f = Fixture(); f.gate.request("7:18"); f.launch()
            assertFalse(f.consume(key, time)); assertFalse(f.consume())
        }
    }
    @Test fun eachNewBootOrVersionGetsOneAttemptAndCanConsumeAtTheDeadline() {
        val f = Fixture()
        for (key in listOf("7:18", "7:19", "8:19")) {
            f.gate.request(key); assertTrue(f.launch(key)); assertFalse(f.launch(key)); assertTrue(f.consume(key, 30_100))
            f.gate.request(key); assertFalse(f.launch(key))
        }
        assertEquals(3, f.launches)
    }
    @Test fun negativeTimeAndFailedConsumptionPersistenceNeverAuthorizeTheActivity() {
        val f = Fixture(); f.gate.request("7:18"); assertFalse(f.launch(time = -1)); assertTrue(f.launch())
        f.failWrite = true; assertThrows(IOException::class.java) { f.consume() }
        f.failWrite = false; assertTrue(f.consume()); assertFalse(f.consume())
    }
}
