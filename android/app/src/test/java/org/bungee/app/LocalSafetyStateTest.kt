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
    @Test fun cameraOptInKeepsItsConnectionRecoverableButStopWithdrawsBoth() {
        val enabled = LocalSafetyState().allowCamera(true)
        assertTrue(enabled.cameraEnabled); assertTrue(enabled.connectionRestartAllowed)
        assertFalse(enabled.restartAllowed) // The independent sharing-only preference is unchanged.
        val stopped = enabled.allowRestart(true).stop()
        assertFalse(stopped.cameraEnabled); assertFalse(stopped.connectionRestartAllowed)
        assertFalse(stopped.clearStop().cameraEnabled)
        assertThrows(IllegalStateException::class.java) { stopped.allowCamera(true) }
        assertThrows(IllegalArgumentException::class.java) { LocalSafetyState(stopped = true, cameraEnabled = true) }
    }
    @Test fun cameraDisarmDoesNotUndoAnIndependentSharingRestartChoice() {
        assertFalse(LocalSafetyState().allowCamera(true).allowCamera(false).connectionRestartAllowed)
        assertTrue(LocalSafetyState().allowRestart(true).allowCamera(true).allowCamera(false).connectionRestartAllowed)
    }
    @Test fun automaticBootWindowsRequireSeparateCameraConsentAndLocalOptIn() {
        assertThrows(IllegalStateException::class.java) { LocalSafetyState().allowCameraRestart(true) }
        val optedIn = LocalSafetyState().allowCamera(true).allowCameraRestart(true)
        assertTrue(optedIn.cameraRestartAllowed)
        assertFalse(optedIn.allowCamera(false).cameraRestartAllowed)
        assertFalse(optedIn.stop().clearStop().allowCamera(true).cameraRestartAllowed)
    }
    @Test fun disablingAutomaticBootRecoveryLeavesCurrentCameraAndSharingChoicesAlone() {
        val state = LocalSafetyState().allowRestart(true).allowCamera(true).allowCameraRestart(true).allowCameraRestart(false)
        assertFalse(state.cameraRestartAllowed); assertTrue(state.cameraEnabled); assertTrue(state.restartAllowed)
        assertThrows(IllegalArgumentException::class.java) { LocalSafetyState(cameraRestartAllowed = true) }
    }
}
