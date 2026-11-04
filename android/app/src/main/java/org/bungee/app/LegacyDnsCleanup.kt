package org.bungee.app

/** Restore-only migration for settings changed by 1.1.16; never enables a resolver. */
data class LegacyDnsSettings(val mode: String?, val hostname: String?)
data class LegacyDnsState(val owned: Boolean, val hostname: String, val status: String, val baseline: LegacyDnsSettings?)
interface LegacyDnsStore { fun read(): LegacyDnsState; fun markRestoring(); fun clear() }
interface LegacyDnsSettingsAccess { fun permitted(): Boolean; fun read(): LegacyDnsSettings; fun write(value: LegacyDnsSettings) }
class LegacyDnsCleanup(private val store: LegacyDnsStore, private val settings: LegacyDnsSettingsAccess) {
    fun restore() {
        val saved = store.read()
        if (saved.owned) {
            val current = settings.read()
            val automatic = LegacyDnsSettings("opportunistic", null)
            val strict = LegacyDnsSettings("hostname", saved.hostname)
            // Include intermediate writes from interrupted activation/fallback/restoration.
            val interrupted = saved.status in listOf("error", "fallback_pending", "restoring") &&
                (current == automatic || current == LegacyDnsSettings("opportunistic", saved.hostname) ||
                    current == LegacyDnsSettings("opportunistic", saved.baseline?.hostname))
            val stillOwned = current == strict || (saved.status == "fallback" && current == automatic) || interrupted
            if (stillOwned) {
                check(settings.permitted()) { "Open Android Private DNS settings and select Automatic, then retry recovery" }
                val previous = saved.baseline ?: automatic
                store.markRestoring()
                settings.write(previous)
                check(settings.read() == previous) { "Android did not confirm restoration; recovery settings were kept" }
            }
            // A manual Android change is preserved, including after a failed restore.
        }
        store.clear() // Keep the undo record if any read, write or verification failed.
    }
}
