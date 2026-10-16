package org.bungee.app

/** SharedPreferences may change its in-memory value even when commit fails.
 * Keep an independent process-wide veto until a later write actually succeeds. */
class CheckedPreference(private val failureValue: Boolean) {
    private var failed = false
    @Synchronized fun read(stored: () -> Boolean): Boolean {
        if (failed) return failureValue
        return try { stored() } catch (_: Exception) { failed = true; failureValue }
    }
    @Synchronized fun write(persist: () -> Boolean) {
        failed = true
        check(persist()) { "Security preference could not be persisted" }
        failed = false
    }
    @Synchronized fun <T> ifEnabled(stored: () -> Boolean, action: () -> T): T {
        check(read(stored)) { "Local command consent is disabled or unavailable" }
        return action()
    }
}
