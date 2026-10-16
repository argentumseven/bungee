package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DdilTest {
    @Test fun outagesBackOffToFiveMinutesAndResetOnlyOnSuccess() {
        val retry = DdilRetry { 1.0 }
        var now = 0L
        for (delay in listOf(15_000L,30_000L,60_000L,120_000L,240_000L,300_000L,300_000L)) {
            retry.attempted(now); retry.failed(now)
            assertEquals(delay, retry.nextAttempt-now); now=retry.nextAttempt
        }
        assertEquals(1,retry.batchSize)
        retry.succeeded(now,1000)
        assertEquals(0,retry.failures); assertEquals(15_000L,retry.nextAttempt-now)
    }
    @Test fun authenticationFailureHasLongCooldownAndNetworkFlappingCannotCauseAnImmediateLoop() {
        val retry=DdilRetry { 0.0 }
        retry.attempted(1000); retry.failed(1000,true)
        assertEquals(721000L,retry.nextAttempt)
        retry.networkChanged(1001); assertEquals(6000L,retry.nextAttempt)
        assertEquals(1,retry.failures)
        retry.attempted(6000); retry.failed(6000); retry.networkChanged(6001)
        assertEquals(11000L,retry.nextAttempt)
    }
    @Test fun bandwidthChangesStayBounded() {
        val retry=DdilRetry { 1.0 }
        repeat(100) { retry.succeeded(0,100) }; assertEquals(100,retry.batchSize)
        repeat(100) { retry.failed(0) }; assertEquals(1,retry.batchSize)
    }
    @Test fun commandClockUsesElapsedTimeAndConservativeLatencyWithoutChangingDeviceTime() {
        val clock=HomeClock()
        assertThrows(IllegalStateException::class.java) { clock.upperNow(0) }
        clock.observe(1000,100,2200)
        assertEquals(1004L,clock.upperNow(2200)); assertEquals(1006L,clock.upperNow(4200))
        assertEquals(1062L,clock.gpsCutoff(4200))
        assertThrows(IllegalArgumentException::class.java) { clock.observe(0,0,1) }
    }
    private fun receipt(id:String) = JSONObject().put("id",id).put("status","failed").put("result","Outcome unknown after interruption; not repeated").put("attempted_at",10)
    @Test fun interruptedAttemptSurvivesRestartAndOnlySettledReceiptsLeaveTheOutbox() {
        val started=ReceiptOutbox.save(JSONArray(),receipt("a"),100,10)
        val restarted=JSONArray(started.toString())
        assertNotNull(ReceiptOutbox.find(restarted,"a"))
        assertEquals(1,ReceiptOutbox.pending(restarted,101).length())
        val settled=ReceiptOutbox.settle(restarted,"a")
        assertEquals(0,ReceiptOutbox.pending(settled,101).length())
        assertNotNull(ReceiptOutbox.find(settled,"a"))
        assertEquals(1,ReceiptOutbox.pending(restarted,101).length())
    }
    @Test fun fullUnresolvedJournalRefusesNewActionsAndNeverEvictsALiveCommand() {
        var records=JSONArray()
        repeat(ReceiptOutbox.CAPACITY) { records=ReceiptOutbox.save(records,receipt("$it"),1000,10) }
        val original=records.toString()
        assertThrows(IllegalStateException::class.java) { ReceiptOutbox.save(records,receipt("new"),1000,10) }
        assertEquals(original,records.toString())
        val completed=receipt("0").put("status","executed")
        records=ReceiptOutbox.save(records,completed,1000,10)
        assertEquals("executed",ReceiptOutbox.find(records,"0")!!.getJSONObject("receipt").getString("status"))
        assertEquals(100,records.length())
    }
    @Test fun journalPrunesOnlyPastReceiptRetentionAndSettledExpiredEntries() {
        var records=ReceiptOutbox.save(JSONArray(),receipt("past"),10,1)
        assertEquals(0,ReceiptOutbox.pending(records,86411).length())
        records=ReceiptOutbox.save(records,receipt("new"),90000,86411)
        assertNull(ReceiptOutbox.find(records,"past")); assertNotNull(ReceiptOutbox.find(records,"new"))
    }
}
