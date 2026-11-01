package org.bungee.app

import kotlin.math.*

/** Conservative short-window estimate. Correlated GNSS fixes do not earn sqrt(N) accuracy. */
object GpsEstimate {
    data class Fix(val latitude: Double, val longitude: Double, val accuracy: Double, val time: Long)
    data class Result(val fix: Fix, val used: Int)
    fun distance(a: Fix, b: Fix): Double {
        val lat = Math.toRadians(b.latitude-a.latitude)
        val lon = Math.toRadians(b.longitude-a.longitude)
        return 12742000 * asin(sqrt((sin(lat/2).pow(2) + cos(Math.toRadians(a.latitude))*cos(Math.toRadians(b.latitude))*sin(lon/2).pow(2)).coerceIn(0.0,1.0)))
    }
    fun estimate(raw: List<Fix>): Result? {
        val points = raw.filter { it.latitude.isFinite() && it.longitude.isFinite() && it.accuracy.isFinite() && it.latitude in -90.0..90.0 && it.longitude in -180.0..180.0 && it.accuracy in 0.1..100.0 && it.time > 0 }.sortedBy { it.time }
        if (points.isEmpty()) return null
        val latest = points.last()
        // Do not pull a moving phone back toward its older positions.
        if (distance(points.first(), latest) > max(30.0, points.first().accuracy + latest.accuracy)) return Result(latest,1)
        val anchor = points.minBy { candidate -> points.sumOf { distance(candidate,it) } }
        val good = points.filter { distance(anchor,it) <= max(30.0, 2*(anchor.accuracy+it.accuracy)) }
        var x=0.0; var y=0.0; var z=0.0; var total=0.0; var reported=0.0
        for (p in good) {
            val weight=1.0/max(5.0,p.accuracy).pow(2)
            val lat=Math.toRadians(p.latitude); val lon=Math.toRadians(p.longitude)
            x+=cos(lat)*cos(lon)*weight; y+=cos(lat)*sin(lon)*weight; z+=sin(lat)*weight
            total+=weight; reported+=p.accuracy.pow(2)*weight
        }
        val center=Fix(Math.toDegrees(atan2(z,sqrt(x*x+y*y))),Math.toDegrees(atan2(y,x)),sqrt(reported/total).coerceAtLeast(5.0),latest.time)
        val spread=sqrt(good.sumOf { distance(center,it).pow(2) }/good.size)
        return Result(center.copy(accuracy=max(center.accuracy,spread)),good.size)
    }
}
