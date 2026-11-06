package org.bungee.app

import android.os.SystemClock
import org.json.JSONObject
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** One process per app data directory; independent Android users have independent locks. */
object RuntimeLease {
    data class Lease(val instance: String, val secret: String, val renewAt: Long)
    private val instance = UUID.randomUUID().toString()
    private val sequence = AtomicLong()
    private var lock: RuntimeProcessLock? = null
    private var realm = ""
    private var lease: Lease? = null
    private val legacy = LegacyRuntimeWindow()
    @Volatile var conflict = false
        private set
    fun nextSequence() = sequence.incrementAndGet()
    @Synchronized fun invalidate() { lease = null }
    @Synchronized fun ensure(identity: Identity, acquire: (JSONObject) -> JSONObject): Lease? {
        if (lock == null) lock = RuntimeProcessLock(identity.runtimeLockFile)
        val bundle = JSONObject(checkNotNull(identity.bundle))
        val nextRealm = bundle.getString("device_id") + ":" + bundle.getJSONObject("wireguard").getString("preshared_key")
        if (nextRealm != realm) { realm = nextRealm; lease = null; conflict = false }
        if (legacy.allows(realm, identity.profileWorkflow, bundle.optInt("runtime_protocol") == 1, SystemClock.elapsedRealtime())) return null
        lease?.takeIf { it.renewAt > SystemClock.elapsedRealtime() }?.let { return it }
        val saved = identity.runtimeState?.let { JSONObject(it) }?.takeIf { it.optString("realm") == realm }
        // Save the candidate before sending. A lost reply can then be retried exactly,
        // or handed off after process death while proving the last active candidate.
        val request = RuntimeHandoff.request(saved, instance, lease?.secret) {
            android.util.Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        }
        val candidate = request.getString("secret")
        identity.profileFingerprint()?.let { request.put("profile_fingerprint", it) }
        identity.runtimeState = JSONObject().put("realm", realm).put("active", saved?.optString("active") ?: "").put("pending", request).toString()
        try { acquire(request) } catch (e: HomeApiException) {
            if (e.status == 404 && !identity.profileWorkflow && bundle.optInt("runtime_protocol") == 0) { legacy.observeOldServer(realm, SystemClock.elapsedRealtime()); return null }
            if (e.status == 423 || e.status == 409) conflict = true
            throw e
        }
        identity.markRuntimeRequired()
        identity.runtimeState = JSONObject().put("realm", realm).put("active", candidate).toString()
        legacy.clear()
        conflict = false
        return Lease(instance, candidate, SystemClock.elapsedRealtime() + 60000).also { lease = it }
    }
}
