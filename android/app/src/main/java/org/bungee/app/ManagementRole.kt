package org.bungee.app

/** Only an ordinary app has the removal path Bungee supports. Query failures block operation. */
enum class ManagementRole {
    PERSONAL, DEVICE_OWNER, PROFILE_OWNER, UNKNOWN;
    val blocksOperation get() = this != PERSONAL
    val removalNotice: String? get() = when (this) {
        PERSONAL -> null
        DEVICE_OWNER -> "Android device ownership remains. Deactivating ordinary administration cannot remove it. Preserve the app data and original signer; do not reset the phone automatically."
        PROFILE_OWNER -> "Android lists Bungee as profile owner. Ordinary administration deactivation cannot remove that role. Preserve the profile, app data and original signer; do not delete the profile as an automatic recovery step."
        UNKNOWN -> "Android management status could not be read. Sharing stays blocked. Check Android security settings before clearing app data or changing signing keys."
    }
    companion object {
        fun inspect(deviceOwner: () -> Boolean, profileOwner: () -> Boolean): ManagementRole = try {
            when {
                deviceOwner() -> DEVICE_OWNER
                profileOwner() -> PROFILE_OWNER
                else -> PERSONAL
            }
        } catch (_: Exception) { UNKNOWN }
    }
}

/** Android may return from removeActiveAdmin before completing removal, or silently refuse it. */
object AdminDeactivation {
    fun request(isActive: () -> Boolean, remove: () -> Unit,
                clock: () -> Long = { System.nanoTime() / 1_000_000 }, pause: (Long) -> Unit = { Thread.sleep(it) }): Boolean {
        if (!isActive()) return true
        remove()
        val started = clock()
        while (isActive()) {
            val age = clock() - started
            if (age < 0 || age >= 2500) return false
            pause(minOf(50, 2500 - age))
        }
        return true
    }
}
