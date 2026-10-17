package org.bungee.app

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ConnectionRecoveryTest {
    @Test fun recoveryWithNoConnectionNeverInitializesABackend() {
        val recovery = ConnectionRecovery(DisclosureFence())
        recovery.stop(); recovery.stop() // No configure/close callback or native initialization.
    }
    @Test fun fullStopClosesAPairingConnectionWithoutASharingService() {
        val fence = DisclosureFence(); val recovery = ConnectionRecovery(fence)
        var running = false; var stopped = false; var publishes = 0
        recovery.open({ !stopped }, { running = true }, { running = false; recovery.clear() }, { publishes++ })
        assertTrue(running)
        fence.change { stopped = true }
        recovery.stop(); assertFalse(running); assertEquals(1, publishes)
        assertThrows(IllegalStateException::class.java) { recovery.open({ !stopped }, { fail("Stopped") }, {}, {}) }
    }
    @Test fun stopAndReenableDuringConfigurationCannotPublishAnOlderPeer() {
        val fence = DisclosureFence(); val recovery = ConnectionRecovery(fence)
        val configured = CountDownLatch(1); val finish = CountDownLatch(1); val done = CountDownLatch(1)
        val closed = AtomicBoolean(false); val published = AtomicBoolean(false); val rejected = AtomicBoolean(false)
        val worker = Thread {
            try {
                recovery.open({ true }, { configured.countDown(); check(finish.await(2, TimeUnit.SECONDS)) }, { closed.set(true) }, { published.set(true) })
            } catch (_: IllegalStateException) { rejected.set(true) } finally { done.countDown() }
        }
        worker.start(); assertTrue(configured.await(1, TimeUnit.SECONDS))
        fence.change { }; recovery.stop(); fence.change { }
        finish.countDown(); assertTrue(done.await(1, TimeUnit.SECONDS)); worker.join()
        assertTrue(rejected.get()); assertTrue(closed.get()); assertFalse(published.get())
    }
    @Test fun aCloseFailureDoesNotSkipOtherRecoveryAndCanBeRetried() {
        val recovery = ConnectionRecovery(DisclosureFence()); var attempts = 0; var otherCleanup = false
        recovery.open({ true }, {}, { if (++attempts == 1) throw IOException("Native teardown failed"); recovery.clear() }, {})
        val errors = RecoveryCoordinator.run({}, listOf("Connection failed" to { recovery.stop() }, "Other cleanup" to { otherCleanup = true }))
        assertEquals(listOf("Connection failed"), errors); assertTrue(otherCleanup)
        recovery.stop(); assertEquals(2, attempts); recovery.stop(); assertEquals(2, attempts)
    }
    @Test fun aFailedPublishClosesTheConfiguredPeer() {
        val recovery = ConnectionRecovery(DisclosureFence()); var closed = false
        assertThrows(IOException::class.java) { recovery.open({ true }, {}, { closed = true; recovery.clear() }, { throw IOException("Publication failed") }) }
        assertTrue(closed)
    }
}
