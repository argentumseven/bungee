package org.bungee.app

enum class RecoveryPhotoTrigger(val reason: String) {
    FAILED_UNLOCK("failed_unlock"),
    LOCAL_TEST("local_test"),
    REMOTE_MANUAL("remote_manual");

    val manual: Boolean get() = this != FAILED_UNLOCK
    fun allowsCapture(locked: Boolean, foregroundUser: Boolean = true): Boolean = when (this) {
        FAILED_UNLOCK -> locked
        LOCAL_TEST -> !locked
        REMOTE_MANUAL -> foregroundUser
    }
}
