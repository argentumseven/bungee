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
    @Test fun onlyTheDedicatedPhotoRouteCanUseALongerBoundedUpload() {
        assertEquals(60_000L,HomeRequestBudget.remaining(90_000,100_000,0,"/v1/photos"))
        assertEquals(10_000L,HomeRequestBudget.remaining(90_000,100_000,0,"/v1/telemetry"))
        assertEquals(250L,HomeRequestBudget.remaining(90_000,100_000,99_750,"/v1/photos"))
    }
}
