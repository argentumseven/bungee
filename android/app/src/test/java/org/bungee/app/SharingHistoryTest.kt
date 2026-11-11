package org.bungee.app

import android.app.ApplicationExitInfo
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SharingHistoryTest {
    @Test fun persistedStopsKeepTheirCauseAndTimeUntilAcknowledged() {
        val stop = SharingEvent.create(SharingReason.NOTIFICATION_STOP, 1234)
        val state = SharingEventJournal.append(JSONObject(), stop)
        val restored = JSONObject(state.toString())
        assertEquals(stop, SharingEventJournal.events(restored).single())
        assertEquals("notification_stop", SharingEventJournal.pending(restored).getJSONObject(0).getString("reason"))
        SharingEventJournal.acknowledge(restored, setOf("unrelated"))
        assertEquals(1, SharingEventJournal.pending(restored).length())
        SharingEventJournal.acknowledge(restored, setOf(stop.id))
        assertEquals(0, SharingEventJournal.pending(restored).length())
        assertEquals(1234L, SharingEventJournal.events(restored).single().at)
        assertEquals("manual", SharingEventJournal.events(restored).single().reason.category)
    }
    @Test fun crashAndSystemExitReasonsAreNotRewrittenAsAppButtonStops() {
        assertEquals(SharingReason.CRASH, SharingHistory.classifyExit(ApplicationExitInfo.REASON_CRASH))
        assertEquals("crash", SharingHistory.classifyExit(ApplicationExitInfo.REASON_CRASH_NATIVE).category)
        assertEquals(SharingReason.ANR, SharingHistory.classifyExit(ApplicationExitInfo.REASON_ANR))
        assertEquals("system", SharingHistory.classifyExit(ApplicationExitInfo.REASON_LOW_MEMORY).category)
        assertEquals("unknown", SharingHistory.classifyExit(ApplicationExitInfo.REASON_UNKNOWN).category)
        assertEquals(SharingReason.ANDROID_USER_STOPPED, SharingHistory.classifyExit(ApplicationExitInfo.REASON_USER_REQUESTED))
        assertEquals("system", SharingHistory.classifyExit(999).category)
    }
    @Test fun anUndetectedExitHasNoInventedStopTime() {
        val event = SharingEvent.create(SharingReason.UNEXPECTED_EXIT, 2000, null)
        assertNull(SharingEvent.parse(event.json()).at)
        assertEquals(2000L, SharingEvent.parse(event.json()).recordedAt)
        assertThrows(IllegalArgumentException::class.java) { SharingEvent.parse(SharingEvent.create(SharingReason.USER_STOP, 2000, null).json()) }
    }
    @Test fun anOfflineQueueIsBoundedAndReportsUnsentLoss() {
        val state = JSONObject()
        repeat(SharingEventJournal.CAPACITY + 3) { SharingEventJournal.append(state, SharingEvent.create(SharingReason.USER_START, 1000L + it)) }
        assertEquals(SharingEventJournal.CAPACITY, SharingEventJournal.events(state).size)
        assertEquals(3L, state.getLong("dropped"))
        assertEquals(SharingEventJournal.BATCH, SharingEventJournal.pending(state).length())
        val event = SharingEventJournal.events(state).last()
        SharingEventJournal.append(state, event)
        assertEquals(3L, state.getLong("dropped"))
    }
    @Test fun acknowledgementDoesNotRemoveAnEventAppendedDuringUpload() {
        val sent = SharingEvent.create(SharingReason.USER_START, 100)
        val stopped = SharingEvent.create(SharingReason.USER_STOP, 110)
        val state = SharingEventJournal.append(JSONObject(), sent)
        SharingEventJournal.append(state, stopped)
        SharingEventJournal.acknowledge(state, setOf(sent.id))
        assertEquals(stopped.id, SharingEventJournal.pending(state).getJSONObject(0).getString("id"))
    }
    @Test fun firstNegotiationPreservesEventsButErasurePreventsOldRetries() {
        val state = SharingEventJournal.append(JSONObject(), SharingEvent.create(SharingReason.USER_STOP, 100))
        SharingEventJournal.reconcileEpoch(state, "a".repeat(64))
        assertEquals(1, SharingEventJournal.pending(state).length())
        SharingEventJournal.reconcileEpoch(state, "b".repeat(64))
        assertEquals(0, SharingEventJournal.pending(state).length())
        assertEquals(1, SharingEventJournal.events(state).size)
    }
    @Test fun clockCorrectionsHoldFutureEventsWithoutBlockingEarlierReports() {
        val state = SharingEventJournal.append(JSONObject(), SharingEvent.create(SharingReason.USER_STOP, 1000))
        SharingEventJournal.append(state, SharingEvent.create(SharingReason.USER_START, 200))
        assertEquals(1, SharingEventJournal.pending(state, 300).length())
        assertEquals("user_start", SharingEventJournal.pending(state, 300).getJSONObject(0).getString("reason"))
    }
    @Test fun aTemporaryLocateDoesNotRequireOrGrantPassiveGpsConsent() {
        assertTrue(TemporaryLocatePolicy.allowed(false, true, true, true, true))
        assertFalse(TemporaryLocatePolicy.allowed(false, false, true, true, true))
        assertFalse(TemporaryLocatePolicy.allowed(true, true, false, true, true))
        assertFalse(TemporaryLocatePolicy.allowed(false, true, true, false, true))
        assertFalse(TemporaryLocatePolicy.allowed(false, true, true, true, false))
        assertTrue(TemporaryLocatePolicy.allowed(true, false, false, true, true))
    }
}
