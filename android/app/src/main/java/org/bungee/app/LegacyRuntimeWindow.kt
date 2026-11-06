package org.bungee.app

/** Compatibility with an old normal server is temporary and cannot cross into profiles. */
class LegacyRuntimeWindow {
    private var realm: String? = null
    private var until = 0L
    fun observeOldServer(realm: String, now: Long) { this.realm=realm; until=now+60000 }
    fun allows(realm: String, profileWorkflow: Boolean, runtimeRequired: Boolean, now: Long) =
        !profileWorkflow && !runtimeRequired && this.realm==realm && now<until
    fun clear() { realm=null; until=0 }
}
