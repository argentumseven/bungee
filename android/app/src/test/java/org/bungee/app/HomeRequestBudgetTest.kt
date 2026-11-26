package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class HomeRequestBudgetTest {
    @Test fun photoUploadCannotPassTheLongWorkerDeadlineToTheTenSecondNativeTransport() {
        assertEquals(10_000L,HomeRequestBudget.remaining(90_000,100_000,10_000))
        assertEquals(10_000L,HomeRequestBudget.remaining(20_000,30_000,10_000))
        assertEquals(10_000L,HomeRequestBudget.remaining(Long.MAX_VALUE,Long.MAX_VALUE,10_000))
    }
    @Test fun nearDeadlinesRemainShortAndExpiredWorkIsVetoed() {
        assertEquals(250L,HomeRequestBudget.remaining(90_000,10_250,10_000))
        assertEquals(100L,HomeRequestBudget.remaining(100,10_250,10_000))
        assertThrows(IllegalStateException::class.java){HomeRequestBudget.remaining(90_000,10_000,10_000)}
    }
    @Test fun anApkChunkGetsHalfAMinuteForAWeakLinkButNothingElseDoes() {
        assertEquals(30_000L,HomeRequestBudget.remaining(90_000,100_000,0,"/v1/app-update/chunk"))
        assertEquals(30_000L,HomeRequestBudget.remaining(30_000,Long.MAX_VALUE,0,"/v1/app-update/chunk"))
        assertEquals(10_000L,HomeRequestBudget.remaining(10_000,Long.MAX_VALUE,0,"/v1/app-update/chunk")) // the default request time is still honored
        assertEquals(250L,HomeRequestBudget.remaining(90_000,100_000,99_750,"/v1/app-update/chunk"))
        for(path in listOf("/v1/app-update","/v1/telemetry","/v1/sync","/v1/commands","/v1/ack","/v1/command-check","/v1/runtime","/v1/enroll"))
            assertEquals(10_000L,HomeRequestBudget.maximum(path))
        assertEquals(60_000L,HomeRequestBudget.maximum("/v1/photos"))
        assertEquals(30_000L,HomeRequestBudget.maximum("/v1/app-update/chunk"))
    }
    @Test fun onlyTheDedicatedPhotoRouteCanUseALongerBoundedUpload() {
        assertEquals(60_000L,HomeRequestBudget.remaining(90_000,100_000,0,"/v1/photos"))
        assertEquals(10_000L,HomeRequestBudget.remaining(90_000,100_000,0,"/v1/telemetry"))
        assertEquals(250L,HomeRequestBudget.remaining(90_000,100_000,99_750,"/v1/photos"))
    }
}
