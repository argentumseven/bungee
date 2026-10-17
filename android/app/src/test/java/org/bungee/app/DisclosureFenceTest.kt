package org.bungee.app

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class DisclosureFenceTest {
    @Test fun preparedBatchCannotReserveAfterWithdrawalEvenIfReenabled() {
        val fence = DisclosureFence()
        val prepared = fence.stamp()
        var consent = true
        fence.change { consent = false }
        fence.change { consent = true }
        var sends = 0
        assertThrows(IllegalStateException::class.java) { fence.reserve(prepared, { consent }, {}, { sends++ }) }
        assertEquals(0, sends)
    }
    @Test fun canceledReservationCannotStartNetworkAfterWithdrawalAcknowledgment() {
        val fence = DisclosureFence()
        var canceled = false
        val ticket = fence.reserve(fence.stamp(), { true }, { canceled = true })
        fence.change { /* persisted false */ }
        assertTrue(canceled)
        fence.release(ticket)
    }
    @Test fun revokeCancelsInFlightExchangeWithoutWaitingForItsNetworkTimeout() {
        val fence = DisclosureFence()
        val entered = CountDownLatch(1)
        val canceled = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val ticket = fence.reserve(fence.stamp(), { true }, { canceled.countDown() })
        val worker = Thread { entered.countDown(); assertTrue(canceled.await(2, TimeUnit.SECONDS)); finished.countDown() }
        worker.start()
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        fence.change { }
        assertTrue(finished.await(1, TimeUnit.SECONDS))
        fence.release(ticket); worker.join()
    }
    @Test fun remoteCaptureStampIsInvalidatedByCommandsOffLocalStopOrErasure() {
        for (reason in listOf("commands", "stop", "epoch")) {
            val fence = DisclosureFence()
            val captured = fence.stamp()
            fence.change { }
            assertThrows(reason, IllegalStateException::class.java) { fence.checked(captured, { true }) { fail("Old capture escaped") } }
        }
    }
    @Test fun failedPersistenceStillCancelsEarlierWorkAndCancellationFailureIsNotSuccess() {
        val fence = DisclosureFence()
        val stamp = fence.stamp()
        var canceled = false
        fence.reserve(stamp, { true }, { canceled = true })
        assertThrows(IllegalStateException::class.java) { fence.change { error("disk failure") } }
        assertTrue(canceled)
        assertThrows(IllegalStateException::class.java) { fence.checked(stamp, { true }) { } }
        fence.reserve(fence.stamp(), { true }, { error("cancel failure") })
        var persisted = false
        assertThrows(IllegalStateException::class.java) { fence.change { persisted = true } }
        assertTrue(persisted)
    }
    @Test fun durableStopLabelDoesNotPromiseAnOrdinaryResume() {
        assertEquals("Stop sharing", SharingControl.label(true, false))
        val persisted = LocalSafetyState().allowRestart(true).stop()
        assertEquals("Open local recovery to resume", SharingControl.label(false, persisted.stopped))
        assertEquals("Start sharing", SharingControl.label(false, persisted.clearStop().stopped))
    }
}
