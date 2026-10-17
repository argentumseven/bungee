package org.bungee.app

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ManagementRoleTest {
    @Test fun onlyAnOrdinaryAppMayUsePersonalMode() {
        assertFalse(ManagementRole.inspect({ false }, { false }).blocksOperation)
        assertEquals(ManagementRole.DEVICE_OWNER, ManagementRole.inspect({ true }, { fail("Unneeded query"); false }))
        val profile = ManagementRole.inspect({ false }, { true })
        assertEquals(ManagementRole.PROFILE_OWNER, profile); assertTrue(profile.blocksOperation)
        assertTrue(profile.removalNotice!!.contains("profile owner"))
    }
    @Test fun failureOfEitherRoleQueryBlocksOperationAndNeverClaimsRemoval() {
        for (deviceFails in listOf(true, false)) {
            val role = ManagementRole.inspect({ if (deviceFails) throw IOException("DPM unavailable"); false }, { throw IOException("DPM unavailable") })
            assertEquals(ManagementRole.UNKNOWN, role); assertTrue(role.blocksOperation)
            assertTrue(role.removalNotice!!.contains("could not be read"))
        }
    }
    @Test fun inactiveAdministrationNeedsNoRemovalRequest() {
        assertTrue(AdminDeactivation.request({ false }, { fail("Nothing to remove") }, { fail("No wait"); 0 }, { fail("No wait") }))
    }
    @Test fun asynchronousRemovalIsConfirmedOnlyAfterAndroidReportsInactive() {
        var now = 0L; var requested = false; var queries = 0
        assertTrue(AdminDeactivation.request({ queries++; !requested || now < 150 }, { requested = true }, { now }, { now += it }))
        assertTrue(requested); assertEquals(150, now); assertTrue(queries > 2)
    }
    @Test fun silentRefusalTimesOutAndApiErrorsRemainErrors() {
        var now = 0L; var requests = 0
        assertFalse(AdminDeactivation.request({ true }, { requests++ }, { now }, { now += it }))
        assertEquals(1, requests); assertEquals(2500, now)
        assertThrows(IOException::class.java) { AdminDeactivation.request({ true }, { throw IOException("Denied") }) }
    }
    @Test fun anInterruptedWaitDoesNotSkipOtherRecoveryActions() {
        var remainingCleanup = false
        val errors = RecoveryCoordinator.run({}, listOf(
            "Removal unfinished" to { AdminDeactivation.request({ true }, {}, { 0 }, { throw InterruptedException() }); Unit },
            "Other cleanup" to { remainingCleanup = true }
        ))
        assertEquals(listOf("Removal unfinished"), errors); assertTrue(remainingCleanup)
    }
}
