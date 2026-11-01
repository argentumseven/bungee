package org.bungee.app

/** Bounds apply to Bungee's own memory, independent of the phone's total RAM. */
object RecoveryPhotoPolicy {
    const val MAX_BYTES = 1024 * 1024
    const val MAX_BASE64_CHARS = ((MAX_BYTES + 2) / 3) * 4
    const val CAPACITY = 8
    const val MAX_EDGE = 2048
    const val MAX_PIXELS = 3_145_728L
    const val MAX_SOURCE_EDGE = 4096
    const val MAX_SOURCE_PIXELS = 8_388_608L
    const val MAX_SOURCE_BYTES = 8 * 1024 * 1024
    const val MIN_INTERVAL_MILLIS = 30_000L
    const val MAX_ATTEMPTS_PER_HOUR = 20

    fun captureSize(sizes: List<Pair<Int, Int>>): Pair<Int, Int>? {
        val bounded = sizes.filter { (w,h) -> w in 1..MAX_SOURCE_EDGE && h in 1..MAX_SOURCE_EDGE && w.toLong()*h <= MAX_SOURCE_PIXELS }
        return bounded.filter { (w,h) -> w <= MAX_EDGE && h <= MAX_EDGE && w.toLong()*h <= MAX_PIXELS }.maxByOrNull { (w,h) -> w.toLong()*h }
            ?: bounded.minByOrNull { (w,h) -> w.toLong()*h }
    }
    fun decodeSample(width: Int, height: Int): Int {
        require(width in 1..MAX_SOURCE_EDGE && height in 1..MAX_SOURCE_EDGE && width.toLong()*height <= MAX_SOURCE_PIXELS)
        var sample=1
        while ((width/sample).toLong()*(height/sample) > MAX_PIXELS) sample*=2
        return sample
    }
}
