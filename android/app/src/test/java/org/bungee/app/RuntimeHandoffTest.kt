package org.bungee.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RuntimeHandoffTest {
    @Test fun repeatedCrashesBeforeOrAfterCommitKeepBothPossibleServerOwnersRecoverable() {
        val prior="a".repeat(43)
        val staged="b".repeat(43)
        var saved=JSONObject().put("active",prior)
        val first=RuntimeHandoff.request(saved,"process-one",null) { staged }
        saved.put("pending",first)
        repeat(5) { n ->
            val retry=RuntimeHandoff.request(saved,"restart-$n",null) { error("Must reuse the staged candidate") }
            assertEquals(staged,retry.getString("secret"))
            val proofs=retry.getJSONArray("previous")
            assertEquals(setOf(prior,staged),(0 until proofs.length()).map { proofs.getString(it) }.toSet())
            saved=JSONObject().put("active",prior).put("pending",retry)
        }
    }
    @Test fun renewalReusesTheActiveProcessSecretWithoutChangingItsGeneration() {
        val active="a".repeat(43)
        val request=RuntimeHandoff.request(JSONObject().put("active",active),"same-process",active) { error("Do not rotate on renewal") }
        assertEquals(active,request.getString("secret"))
    }
}
