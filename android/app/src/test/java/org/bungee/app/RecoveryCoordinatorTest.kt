package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class RecoveryCoordinatorTest {
    @Test fun aFailedLegacyActionCannotSkipTheRestAndStopIsSavedFirst() {
        val visited = mutableListOf<String>()
        val failures = RecoveryCoordinator.run({ visited += "persist local stop" }, listOf(
            "service failed" to { visited += "stop service" },
            "old policy could not be cleared" to { visited += "clear old policy"; throw IllegalStateException("Android refused") },
            "notification failed" to { visited += "clear notification" }
        ))
        assertEquals(listOf("persist local stop", "stop service", "clear old policy", "clear notification"), visited)
        assertEquals(listOf("old policy could not be cleared"), failures)
    }
    @Test fun fullStorageDoesNotPreventIndependentStopAndCleanupAttemptsOrClaimSuccess() {
        val visited = mutableListOf<String>()
        val failures = RecoveryCoordinator.run({ throw IllegalStateException("No space to persist stop") }, listOf(
            "stop failed" to { visited += "stop" },
            "cleanup failed" to { visited += "cleanup" }
        ))
        assertEquals(listOf("stop", "cleanup"), visited)
        assertEquals(1, failures.size)
        assertTrue(failures.first().contains("force-stop"))
    }
}
