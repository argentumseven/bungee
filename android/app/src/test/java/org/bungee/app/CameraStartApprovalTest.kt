package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class CameraStartApprovalTest {
    @Test fun aStartThatNeverArrivesDoesNotBlockAllFutureAttempts() {
        val approvals = CameraStartApproval(); val first = approvals.issue(100)!!
        assertNull(approvals.issue(5100))
        val second = approvals.issue(5101)!!
        assertNotEquals(first, second); assertTrue(approvals.consume(second, 5102))
    }
    @Test fun aDelayedOlderIntentCannotConsumeANewerApproval() {
        val approvals = CameraStartApproval(); val first = approvals.issue(0)!!; val second = approvals.issue(5001)!!
        assertFalse(approvals.consume(first, 5002)); assertTrue(approvals.consume(second, 5003))
        assertFalse(approvals.consume(second, 5004))
    }
    @Test fun expiryClockReversalAndExplicitDisarmRejectAuthority() {
        val approvals = CameraStartApproval(); val expired = approvals.issue(0)!!
        assertFalse(approvals.consume(expired, 5001))
        val future = approvals.issue(100)!!; assertFalse(approvals.consume(future, 99))
        val canceled = approvals.issue(101)!!; approvals.cancel(); assertFalse(approvals.consume(canceled, 102))
    }
}
