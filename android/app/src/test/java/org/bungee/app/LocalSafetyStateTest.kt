package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class LocalSafetyStateTest {
    @Test fun stoppingWithdrawsAnEarlierRestartOptIn() {
        val stopped = LocalSafetyState().allowRestart(true).stop()
        assertTrue(stopped.stopped); assertFalse(stopped.restartAllowed)
    }
    @Test fun clearingStopDoesNotRestoreOldConsentOrAuthorizeAnAutomaticRestart() {
        val cleared = LocalSafetyState().allowRestart(true).stop().clearStop()
        assertFalse(cleared.stopped); assertFalse(cleared.restartAllowed)
        assertTrue(cleared.allowRestart(true).restartAllowed)
    }
    @Test fun inconsistentOrRemoteRestartWhileLocallyStoppedCannotBeAccepted() {
        assertThrows(IllegalArgumentException::class.java) { LocalSafetyState(stopped = true, restartAllowed = true) }
        assertThrows(IllegalStateException::class.java) { LocalSafetyState(stopped = true).allowRestart(true) }
    }
}
