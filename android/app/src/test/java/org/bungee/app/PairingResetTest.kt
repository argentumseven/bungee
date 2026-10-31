package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class PairingResetTest {
    @Test fun resetStopsBeforeErasingAndOnlyThenAllowsManualPairing() {
        val events = mutableListOf<String>()
        PairingReset.run({ ManagementRole.PERSONAL }, { events += "stop" }, { events += "erase" }, { events += "ready" })
        assertEquals(listOf("stop", "erase", "ready"), events)
    }
    @Test fun ownerOrUnknownStateCannotEraseKeys() {
        for (role in listOf(ManagementRole.DEVICE_OWNER, ManagementRole.PROFILE_OWNER, ManagementRole.UNKNOWN)) {
            assertThrows(IllegalStateException::class.java) {
                PairingReset.run({ role }, { fail("Must preserve state") }, { fail("Keys must survive") }, { fail("Must not resume") })
            }
        }
    }
    @Test fun stopOrErasureFailureCannotPermitRestart() {
        for (stopFails in listOf(true, false)) assertThrows(IllegalStateException::class.java) {
            PairingReset.run({ ManagementRole.PERSONAL }, { if (stopFails) error("storage failure") }, {
                if (stopFails) fail("Cannot erase after failed stop") else error("erase failure")
            }, { fail("Must remain stopped") })
        }
    }
    @Test fun ownershipChangingDuringStopPreservesIdentity() {
        var role = ManagementRole.PERSONAL
        assertThrows(IllegalStateException::class.java) {
            PairingReset.run({ role }, { role = ManagementRole.DEVICE_OWNER }, { fail("Keys must survive") }, {})
        }
    }
    @Test fun onlyConfirmedDeviceOwnerCanBeReleasedAndOnlyAfterPolicyCleanup() {
        var role = ManagementRole.DEVICE_OWNER
        val events = mutableListOf<String>()
        assertTrue(OwnershipRepair.run({ role }, { events += "policies"; emptyList() }, { events += "release"; role = ManagementRole.PERSONAL }).isEmpty())
        assertEquals(listOf("policies", "release"), events)
    }
    @Test fun profileOwnerUnknownAndFailedCleanupNeverRemoveOwnership() {
        for (role in listOf(ManagementRole.PROFILE_OWNER, ManagementRole.UNKNOWN)) {
            assertFalse(OwnershipRepair.run({ role }, { fail("No mutation"); emptyList() }, { fail("No release") }).isEmpty())
        }
        assertEquals(listOf("cleanup failed"), OwnershipRepair.run({ ManagementRole.DEVICE_OWNER }, { listOf("cleanup failed") }, { fail("Do not strand legacy policy") }))
        assertFalse(OwnershipRepair.run({ ManagementRole.DEVICE_OWNER }, { emptyList() }, {}).isEmpty())
    }
}
