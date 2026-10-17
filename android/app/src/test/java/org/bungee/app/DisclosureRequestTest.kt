package org.bungee.app

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class DisclosureRequestTest {
    @Test fun actualSendOrchestratorRejectsBatchPreparedBeforeConsentChanged() {
        val fence = DisclosureFence()
        val stamp = fence.stamp() // A backlog has been copied into a request body.
        var reservations = 0
        fence.change { }
        val request = DisclosureRequest(fence, { reservations++; 1L }, {})
        assertThrows(IllegalStateException::class.java) { request.exchange(stamp, { true }, { 10000 }) { _,_ -> fail("A prepared batch escaped") } }
        assertEquals(0, reservations)
    }
    @Test fun revocationDuringPreparedOrInflightSendCancelsBeforeOwnerAcknowledgment() {
        for (networkStarted in listOf(false,true)) {
            val fence = DisclosureFence()
            val stamp = fence.stamp()
            val entered = CountDownLatch(1)
            val proceed = CountDownLatch(1)
            val canceled = AtomicBoolean(false)
            val transmitted = AtomicBoolean(false)
            val accepted = AtomicBoolean(false)
            val stopped = CountDownLatch(1)
            val request = DisclosureRequest(fence, { 1L }, { canceled.set(true); proceed.countDown() })
            val worker = Thread {
                try {
                    request.exchange(stamp, { true }, { 10000 }) { _,_ ->
                        if (networkStarted) transmitted.set(true)
                        entered.countDown()
                        check(proceed.await(2, TimeUnit.SECONDS))
                        check(!canceled.get()) { "transport canceled" }
                        transmitted.set(true)
                        true
                    }
                    accepted.set(true)
                } catch (_: IllegalStateException) { } finally { stopped.countDown() }
            }
            worker.start();assertTrue(entered.await(1, TimeUnit.SECONDS))
            fence.change { } // Completes without waiting for a network timeout.
            assertTrue(canceled.get());assertTrue(stopped.await(1, TimeUnit.SECONDS));assertFalse(accepted.get())
            if (!networkStarted) assertFalse(transmitted.get()) // A send already started may have delivered bytes.
            worker.join()
        }
    }
    @Test fun expiredBudgetCannotSendAndAResponseWithoutCurrentConsentIsNotSuccess() {
        val fence = DisclosureFence()
        val request = DisclosureRequest(fence, { 1L }, {})
        assertThrows(IllegalStateException::class.java) { request.exchange(fence.stamp(), { true }, { 0 }) { _,_ -> fail("Expired upload") } }
        assertThrows(IllegalStateException::class.java) { request.exchange(fence.stamp(), { true }, { 10000 }) { _,_ -> fence.change { }; "old success" } }
    }
}
