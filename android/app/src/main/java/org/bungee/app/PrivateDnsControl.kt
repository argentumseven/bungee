package org.bungee.app

/** Separate from pairing so a damaged identity cannot prevent offline DNS restoration. */
data class DnsSettings(val mode: String?, val hostname: String?)
data class PrivateDnsPolicy(val revision: Long, val enabled: Boolean, val configured: Boolean, val hostname: String, val fallback: Boolean, val removed: Boolean)
data class PrivateDnsState(
    val consent: Boolean = false, val revision: Long = -1, val hostname: String = "",
    val fallback: Boolean = true, val baseline: DnsSettings? = null, val owned: Boolean = false,
    val status: String = "disabled", val detail: String = "Normal Android DNS"
)
interface PrivateDnsStore { fun read(): PrivateDnsState; fun write(state: PrivateDnsState) }
interface PrivateDnsSettings { fun permitted(): Boolean; fun read(): DnsSettings; fun write(value: DnsSettings) }

/** Every OS mutation has a durable undo record first. A manual Android change cancels ownership. */
class PrivateDnsControl(private val store: PrivateDnsStore, private val settings: PrivateDnsSettings) {
    companion object {
        fun validHost(host: String) = host.length in 3..253 && host.contains('.') && host.any { it in 'a'..'z' } &&
            host.split('.').all { it.length in 1..63 && it.first() != '-' && it.last() != '-' && it.all { c -> c in 'a'..'z' || c in '0'..'9' || c == '-' } }
        val AUTOMATIC = DnsSettings("opportunistic", null)
    }
    @Synchronized fun state() = store.read()
    @Synchronized fun approve() { check(settings.permitted()) { "Grant WRITE_SECURE_SETTINGS with ADB first" }; store.write(store.read().let { if (it.owned) it.copy(consent=true) else it.copy(consent=true,status="disabled",detail="Approved locally; waiting for DNS configuration") }) }
    private fun target(s: PrivateDnsState) = if (s.status == "fallback") AUTOMATIC else DnsSettings("hostname", s.hostname)
    private fun owns(s: PrivateDnsState) = s.owned && (s.status in listOf("error", "fallback_pending") || settings.read() == target(s))
    private fun restore(s: PrivateDnsState, automatic: Boolean): PrivateDnsState {
        if (!s.owned) return s
        // Never overwrite a setting the phone's owner changed outside Bungee.
        if (owns(s)) {
            check(settings.permitted()) { "DNS restore needs the ADB grant or Android Private DNS settings" }
            val value = if (automatic) AUTOMATIC else s.baseline ?: AUTOMATIC
            settings.write(value)
            check(settings.read() == value) { "Android did not confirm DNS restoration; saved recovery settings were kept" }
        }
        return s.copy(owned = false, baseline = null)
    }
    @Synchronized fun disable(remove: Boolean = false) {
        val restored = restore(store.read(), false)
        store.write(restored.copy(consent = false, hostname = if (remove) "" else restored.hostname,
            status = if (remove) "removed" else "disabled", detail = if (remove) "DNS setup removed; previous Android DNS restored" else "Previous Android DNS restored"))
    }
    @Synchronized fun apply(p: PrivateDnsPolicy) {
        require(p.revision >= 0)
        var s = store.read()
        if (p.revision < s.revision) return
        if (p.removed || !p.enabled || !p.configured) {
            s = restore(s, false)
            val removed=p.removed || (s.status=="removed" && !s.consent)
            store.write(s.copy(revision = p.revision, fallback = p.fallback, consent = s.consent && !removed,
                hostname = if (removed) "" else s.hostname, status = if (removed) "removed" else "disabled",
                detail = if (removed) "DNS setup removed; previous Android DNS restored" else "Normal Android DNS; Bungee routing off"))
            return
        }
        if(s.owned && s.status in listOf("error","fallback_pending")) { interrupted();s=store.read() }
        require(validHost(p.hostname)) { "Private DNS requires a TLS hostname, not an IP address" }
        if (s.owned && !owns(s)) {
            store.write(s.copy(consent = false, owned = false, baseline = null, revision = p.revision, status = "disabled", detail = "Android DNS changed manually; automatic control paused")); return
        }
        if (!s.consent) { store.write(s.copy(revision = p.revision, status = if(s.status=="removed") "removed" else "disabled", detail = if(s.status=="removed") s.detail else "Approve DNS control on this phone first")); return }
        if (!settings.permitted()) { store.write(s.copy(revision = p.revision, status = "permission_required", detail = "One-time ADB permission is required")); return }
        // A failure fallback stays latched until an explicit new revision or local retry.
        if (s.revision == p.revision && s.status == "fallback") return
        if (s.owned && s.hostname != p.hostname) s = restore(s, false)
        if (s.status == "fallback" && s.owned) {
            // The new revision is an explicit retry; preserve the original baseline.
            s=s.copy(owned=false,status="disabled")
        }
        if (!s.owned) {
            s = s.copy(baseline = s.baseline ?: settings.read(), owned = true, hostname = p.hostname, revision = p.revision, fallback = p.fallback, status = "error", detail = "DNS activation interrupted; restore is available")
            store.write(s) // Persist undo before changing Android.
            try {
                settings.write(target(s))
                check(settings.read() == target(s)) { "Android did not confirm the DNS setting" }
            } catch (e: Exception) {
                // A partially completed write is explicitly rolled back, even if strict mode was not set yet.
                runCatching { settings.write(s.baseline ?: AUTOMATIC) }
                throw e
            }
        }
        store.write(s.copy(revision = p.revision, fallback = p.fallback, status = "active", detail = "Private DNS selected; Android validation is checked separately"))
    }
    @Synchronized fun failed() {
        val s = store.read()
        if (!s.owned || !s.fallback) return
        if (!owns(s)) { store.write(s.copy(consent=false,owned=false,baseline=null,status="disabled",detail="Android DNS changed manually; control paused")); return }
        store.write(s.copy(status="fallback_pending",detail="Restoring Automatic DNS"))
        settings.write(AUTOMATIC)
        check(settings.read()==AUTOMATIC) { "Android did not confirm Automatic DNS" }
        // Keep the original undo record: a later explicit Off can restore a prior custom provider.
        store.write(s.copy(status = "fallback", detail = "DNS checks failed; using Automatic DNS until you retry"))
    }
    @Synchronized fun interrupted() {
        val s = store.read()
        if (!s.owned) return
        if (s.status == "fallback") return
        if (s.fallback && owns(s)) {
            store.write(s.copy(status="fallback_pending",detail="Restoring Automatic DNS"))
            settings.write(AUTOMATIC)
            check(settings.read()==AUTOMATIC)
            store.write(s.copy(status="fallback",detail="DNS monitor restarted; Automatic DNS restored until you retry"))
        } else {
            val restored=restore(s,false)
            store.write(restored.copy(status="fallback",detail="DNS monitor restarted; previous DNS restored until you retry"))
        }
    }
    @Synchronized fun retry() { val s=store.read(); store.write(s.copy(revision = -1, detail = "Retry requested")) }
}
