package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class GpsEstimateTest {
    private fun fix(lat:Double,lon:Double,time:Long,accuracy:Double=10.0)=GpsEstimate.Fix(lat,lon,accuracy,time)
    @Test fun stationaryJitterIsAveragedWithoutClaimingSubmeterAccuracy() {
        val points=(0..20).map {fix(33.0+(it%3-1)*0.00003,-80.0+(it%3-1)*0.00002,it+1L,1.0)}
        val result=GpsEstimate.estimate(points)!!
        assertEquals(21,result.used);assertEquals(33.0,result.fix.latitude,0.00001)
        assertTrue(result.fix.accuracy>=5);assertEquals(21L,result.fix.time)
    }
    @Test fun movingPhoneUsesLatestFixInsteadOfPullingItBackward() {
        val points=listOf(fix(33.0,-80.0,1),fix(33.001,-80.0,2),fix(33.002,-80.0,3))
        val result=GpsEstimate.estimate(points)!!;assertEquals(points.last(),result.fix);assertEquals(1,result.used)
    }
    @Test fun invalidFixesAreRefusedAndAntimeridianAveragesStayNearTheDateLine() {
        assertNull(GpsEstimate.estimate(listOf(fix(Double.NaN,0.0,1))))
        val result=GpsEstimate.estimate(listOf(fix(0.0,179.99999,1),fix(0.0,-179.99999,2)))!!
        assertTrue(kotlin.math.abs(result.fix.longitude)>179.9)
    }
}
