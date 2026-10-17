package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CameraRestartTest {
    @Test fun processRestartRetainsFailuresAndCannotRetriggerAConsumedStreak() {
        val original = CameraLease.obtain(JSONObject(), 7, 0, 0, visibleStart = true)
        assertFalse(original.gate.failed(1, 1))
        val restarted = CameraLease.obtain(JSONObject(original.snapshot().toString()), 7, 2, 1, visibleStart = false)
        assertEquals(original.id, restarted.id)
        assertFalse(restarted.gate.failed(2, 2)); assertTrue(restarted.gate.failed(3, 3))
        val again = CameraLease.obtain(JSONObject(restarted.snapshot().toString()), 7, 400_000, 4, visibleStart = false)
        assertFalse(again.gate.failed(4, 400_000))
    }
    @Test fun successfulUnlockAndAttemptBudgetSurviveRestart() {
        var lease = CameraLease.obtain(JSONObject(), 1, 0, 0, visibleStart = true)
        for (i in 0..5) {
            assertTrue(lease.gate.test(i * 300_000L))
            lease = CameraLease.obtain(JSONObject(lease.snapshot().toString()), 1, i * 300_000L, 0, visibleStart = false)
        }
        lease.gate.reset()
        lease = CameraLease.obtain(lease.snapshot(), 1, 1_800_000, 0, visibleStart = false)
        assertFalse(lease.gate.failed(3, 1_800_000)); assertFalse(lease.gate.test(3_599_999))
        assertTrue(lease.gate.test(3_600_000))
    }
    @Test fun bootAndAbsentCheckpointNeedAVisibleStartWithoutReusingOldFailures() {
        val old = CameraLease.obtain(JSONObject(), 1, 5_000, 0, visibleStart = true)
        assertThrows(IllegalStateException::class.java) { CameraLease.obtain(old.snapshot(), 2, 10, 0, visibleStart = false) }
        assertThrows(IllegalStateException::class.java) { CameraLease.obtain(JSONObject(), 1, 6_000, 0, visibleStart = false) }
        val afterBoot = CameraLease.obtain(old.snapshot(), 2, 10, 4, visibleStart = true)
        assertNotEquals(old.id, afterBoot.id)
        assertFalse(afterBoot.gate.failed(4, 11)); assertFalse(afterBoot.gate.failed(6, 12)); assertTrue(afterBoot.gate.failed(7, 13))
    }
    @Test fun corruptOrFutureCheckpointsFailClosedInsteadOfResettingTheBudget() {
        val lease = CameraLease.obtain(JSONObject(), 1, 0, 0, visibleStart = true)
        assertTrue(lease.gate.test(10))
        assertThrows(IllegalArgumentException::class.java) { CameraLease.obtain(lease.snapshot(), 1, 9, 0, visibleStart = false) }
        val state = lease.snapshot().getJSONObject("gate").put("attempts", JSONArray(listOf(0, 1)))
        assertThrows(IllegalArgumentException::class.java) { FailedUnlockGate.restore(state, 20) }
        state.put("attempts", JSONArray()).put("baseline", 3).put("previous", 2)
        assertThrows(IllegalArgumentException::class.java) { FailedUnlockGate.restore(state, 20) }
    }
}
