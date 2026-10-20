package org.bungee.app

/** Quality decisions for fresh, consent-checked GPS_PROVIDER observations. */
object GpsFixQuality {
    const val IDEAL_METERS = 25f
    const val MAX_METERS = 100f
    fun usable(latitude: Double, longitude: Double, accuracyMeters: Float, hasAccuracy: Boolean): Boolean =
        hasAccuracy && latitude.isFinite() && longitude.isFinite() &&
            latitude in -90.0..90.0 && longitude in -180.0..180.0 &&
            accuracyMeters.isFinite() && accuracyMeters > 0f && accuracyMeters <= MAX_METERS
    fun prefer(candidateMeters: Float, currentMeters: Float?): Boolean =
        currentMeters == null || candidateMeters < currentMeters
    fun ideal(accuracyMeters: Float): Boolean = accuracyMeters <= IDEAL_METERS
}
