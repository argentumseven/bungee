package org.bungee.app
import org.junit.Assert.*
import org.junit.Test
class GpsFixQualityTest {
 @Test fun validatesAccuracyAndCoordinates() {
  assertTrue(GpsFixQuality.usable(32.0,-80.0,12f,true))
  assertFalse(GpsFixQuality.usable(32.0,-80.0,12f,false))
  assertFalse(GpsFixQuality.usable(32.0,-80.0,101f,true))
  assertFalse(GpsFixQuality.usable(91.0,-80.0,12f,true))
  assertFalse(GpsFixQuality.usable(32.0,181.0,12f,true))
  assertFalse(GpsFixQuality.usable(32.0,-80.0,Float.NaN,true))
 }
 @Test fun improvesBeforeReturning() {
  assertTrue(GpsFixQuality.prefer(15f,40f))
  assertFalse(GpsFixQuality.prefer(40f,15f))
  assertTrue(GpsFixQuality.ideal(25f))
  assertFalse(GpsFixQuality.ideal(25.1f))
 }
}
