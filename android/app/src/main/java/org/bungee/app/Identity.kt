package org.bungee.app

import android.content.Context
import android.content.Intent
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.wireguard.crypto.KeyPair
import com.wireguard.crypto.Key
import org.json.JSONObject
import org.json.JSONArray
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Private signing keys stay in Android Keystore; WireGuard's userspace key is encrypted at rest. */
class Identity(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = context.getSharedPreferences("identity", Context.MODE_PRIVATE)
    private val generation = prefs.getString("identity_generation", null)
    private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    init { synchronized(identityInitialization) {
        val bound = prefs.getBoolean("enrolled", false) || prefs.contains("bundle")
        if (!keys.containsAlias("bungee-signing")) {
            check(!bound) { "Existing signing key is unavailable; use local recovery" }
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder("bungee-signing", KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
            }.generateKeyPair()
        }
        if (!keys.containsAlias("bungee-storage")) {
            check(!prefs.all.keys.any { it == "gps_epoch_v1" || it == "wg_private" || it == "bundle" || it == "recovery_message" || it == "location_queue" || it == "gps_backlog_v2" || it == "receipt_outbox" || it.startsWith("state_") || it.startsWith("receipt_") }) { "Existing encryption key is unavailable; original records preserved" }
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder("bungee-storage", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
        }
        if (!prefs.contains("wg_private")) {
            check(!bound) { "Existing WireGuard key is unavailable; use local recovery" }
            val pair = KeyPair()
            check(prefs.edit().putString("wg_private", encrypted(pair.privateKey.toBase64())).putString("wg_public", pair.publicKey.toBase64()).commit()) { "Could not persist the WireGuard key pair" }
        } else {
            val derived = KeyPair(Key.fromBase64(wgPrivate)).publicKey.toBase64()
            if (prefs.getString("wg_public", null) != derived)
                check(prefs.edit().putString("wg_public", derived).commit()) { "Could not repair the public key from its existing private key" }
        }
        synchronized(PhotoOutbox.lock) {
            if (prefs.contains("state_armed_photos")) {
                PendingPhotos.adoptLegacy(state("armed_photos"))
                check(prefs.edit().remove("state_armed_photos").commit()) { "Could not remove migrated photo storage; original pictures preserved" }
            }
        }
    } }
    private fun currentIdentity() = generation == prefs.getString("identity_generation", null)
    fun requestsAllowed() = currentIdentity() && !LocalSafety.isStopped(appContext) && !ManagementAgent.blocksPersonalOperation(appContext)
    val wgPublic: String get() = prefs.getString("wg_public", "")!!
    val wgPrivate: String get() = secret("wg_private")!!
    val publicKey: String get() = encode(keys.getCertificate("bungee-signing").publicKey.encoded)
    var bundle: String?
        get() = secret("bundle")
        set(value) = synchronized(identityInitialization) { check(currentIdentity()) { "Pairing was reset; reopen Bungee" }; if (value == null) check(prefs.edit().remove("bundle").commit()) { "Could not clear pairing invitation" } else putSecret("bundle", value) }
    var enrolled: Boolean
        get() = prefs.getBoolean("enrolled", false)
        set(value) = synchronized(identityInitialization) { check(currentIdentity()) { "Pairing was reset; reopen Bungee" }; check(prefs.edit().putBoolean("enrolled", value).commit()) { "Could not persist enrollment state" } }
    var appLock: Boolean
        get() = appLockPreference.read { prefs.getBoolean("app_lock", false) }
        set(value) { appLockPreference.write { prefs.edit().putBoolean("app_lock", value).commit() } }
    var allowLocate: Boolean
        get() = locationPreference.read { prefs.getBoolean("allow_locate", true) }
        set(value) = PrivacySends.fence.change {
            synchronized(GpsStorage.lock) {
                if (value && !allowLocate) newJournal().clear()
                locationPreference.write {
                    val edit = prefs.edit().putBoolean("allow_locate", value)
                    if (!value) edit.remove("location_queue").remove("gps_backlog_v2")
                    edit.commit()
                }
                if (!value) newJournal().clear()
            }
        }
    val gpsEpoch: String? get() = secret("gps_epoch_v1")
    fun reconcileGpsEpoch(epoch: String) {
        require(epoch.matches(Regex("[A-Za-z0-9_-]{43}|[a-f0-9]{64}"))) { "Home GPS generation is unavailable; update the server" }
        if (gpsEpoch == epoch) return
        PrivacySends.fence.change { synchronized(GpsStorage.lock) {
            newJournal().clear()
            check(prefs.edit().remove("location_queue").remove("gps_backlog_v2").commit())
            putSecret("gps_epoch_v1", epoch)
        } }
    }
    var allowCommands: Boolean
        get() = commandPreference.read { prefs.getBoolean(COMMAND_CONSENT, false) }
        set(value) {
            val cameraFailure = if (!value) runCatching { ArmedCameraService.disarm(appContext) }.exceptionOrNull() else null
            try {
                PrivacySends.fence.change {
                    check(!value || !LocalSafety.isStopped(appContext)) { "Use local recovery before enabling commands" }
                    commandPreference.write { prefs.edit().putBoolean(COMMAND_CONSENT, value).commit() }
                }
                // Close a concurrent local enable between the initial camera stop and
                // the command-consent commit. A later enable now sees commands disabled.
                if (!value && LocalSafety.isCameraEnabled(appContext)) ArmedCameraService.disarm(appContext)
                cameraFailure?.let { throw it }
            }
            catch (e: Exception) {
                // Independent, best-effort durable stop. If storage prevents that too,
                // the UI directs the user to deactivate administration and force-stop in Android Settings.
                runCatching { LocalSafety.setStopped(appContext, true) }
                runCatching { appContext.stopService(Intent(appContext, TelemetryService::class.java)) }
                throw e
            }
        }
    fun <T> ifCommandsAllowed(action: () -> T): T = commandPreference.ifEnabled({ prefs.getBoolean(COMMAND_CONSENT, false) }, action)
    internal fun state(name: String): JSONObject = secret("state_$name")?.let(::JSONObject) ?: JSONObject()
    internal fun saveState(name: String, value: JSONObject) = putSecret("state_$name", value.toString())
    val photoEpoch: String? get() = secret("state_photo_epoch")?.let(::JSONObject)?.getString("epoch")
    fun reconcilePhotoEpoch(epoch: String) {
        require(epoch.matches(Regex("[A-Za-z0-9_-]{43}|[a-f0-9]{64}")))
        if (photoEpoch == epoch) return
        PrivacySends.fence.change { synchronized(PhotoOutbox.lock) {
            ArmedCameraService.discardPending(appContext)
            saveState("photo_epoch", JSONObject().put("epoch", epoch))
            ArmedCameraService.currentSession()?.let {
                PendingPhotos.resume(it)
                ArmedCameraService.refreshQueue(this, it)
            }
        } }
    }
    fun resumePhotoSession(session: String) = synchronized(PhotoOutbox.lock) {
        check(prefs.edit().remove("state_armed_photos").commit()) { "Could not remove the old persisted photo queue" }
        PendingPhotos.resume(session)
    }
    fun queuePhoto(photo: JSONObject, session: String, epoch: String, stamp: DisclosureFence.Stamp, allowed: () -> Boolean) = PrivacySends.fence.checked(stamp, allowed) {
        synchronized(PhotoOutbox.lock) {
            check(photoEpoch == epoch)
            PendingPhotos.append(photo, session)
        }
    }
    fun pendingPhoto(session: String): JSONObject? = synchronized(PhotoOutbox.lock) {
        PendingPhotos.first(session)
    }
    fun photoQueueReport(session: String? = null): Pair<Int, Long> = synchronized(PhotoOutbox.lock) {
        PendingPhotos.report(session)
    }
    fun acknowledgePhoto(id: String, session: String, stamp: DisclosureFence.Stamp, allowed: () -> Boolean) = PrivacySends.fence.checked(stamp, allowed) {
        synchronized(PhotoOutbox.lock) {
            PendingPhotos.acknowledge(id, session)
        }
    }
    var recoveryMessage: String?
        get() = secret("recovery_message")
        set(value) { if (value == null) check(prefs.edit().remove("recovery_message").commit()) { "Could not clear recovery message" } else putSecret("recovery_message", value) }
    private fun newJournal() = GpsJournal(GpsStorage.database(appContext), GpsCipher { keys.getKey("bungee-storage", null) as SecretKey })
    private fun journal(): GpsJournal {
        val journal = newJournal()
        if (!allowLocate) journal.clear()
        else if (!journal.migrated()) {
            val legacy = secret("gps_backlog_v2")?.let(::JSONObject)
                ?: JSONObject().put("points", JSONArray(secret("location_queue") ?: "[]")).put("dropped", 0)
            journal.migrate(legacy.getJSONArray("points"), legacy.optLong("dropped"))
        }
        // Only after a committed migration/clear. Its marker prevents reimport if this write fails.
        if (prefs.contains("location_queue") || prefs.contains("gps_backlog_v2"))
            check(prefs.edit().remove("location_queue").remove("gps_backlog_v2").commit()) { "Old GPS queue cleanup failed" }
        return journal
    }
    fun queueLocation(point: JSONObject, stamp: DisclosureFence.Stamp, epoch: String) = PrivacySends.fence.checked(stamp, { enrolled && allowLocate && gpsEpoch == epoch && requestsAllowed() }) {
        synchronized(GpsStorage.lock) { if (GpsBacklog.usable(point)) journal().append(point) }
    }
    fun pendingLocations(limit: Int = 100, before: Long = Long.MAX_VALUE): JSONArray = synchronized(GpsStorage.lock) { if (!allowLocate) JSONArray() else journal().batch(limit, before) }
    fun newestQueuedLocation(before: Long): JSONObject? = synchronized(GpsStorage.lock) {
        if (!allowLocate) return null
        journal().newest(before)
    }
    fun backlogReport(): JSONObject = synchronized(GpsStorage.lock) {
        journal().report()
            .put("pending_receipts", ReceiptOutbox.pending(receipts(), System.currentTimeMillis()/1000, 100).length())
    }
    fun acknowledgeLocations(sent: JSONArray, stamp: DisclosureFence.Stamp, epoch: String) = PrivacySends.fence.checked(stamp, { allowLocate && gpsEpoch == epoch && requestsAllowed() }) {
        synchronized(GpsStorage.lock) { journal().acknowledge(sent) }
    }
    private fun receipts() = JSONArray(secret("receipt_outbox") ?: "[]")
    @Synchronized fun result(id: String): JSONObject? = ReceiptOutbox.find(receipts(), id)?.getJSONObject("receipt") ?: secret("receipt_$id")?.let(::JSONObject)
    @Synchronized fun saveResult(id: String, result: JSONObject, expires: Long) {
        require(result.getString("id") == id)
        putSecret("receipt_outbox", ReceiptOutbox.save(receipts(), result, expires, System.currentTimeMillis()/1000).toString())
    }
    @Synchronized fun pendingReceipts(): JSONArray = ReceiptOutbox.pending(receipts(), System.currentTimeMillis()/1000)
    @Synchronized fun settleReceipt(id: String) { putSecret("receipt_outbox", ReceiptOutbox.settle(receipts(), id).toString()) }
    fun sign(text: String): String = Signature.getInstance("SHA256withECDSA").run {
        initSign(keys.getKey("bungee-signing", null) as java.security.PrivateKey); update(text.toByteArray(Charsets.UTF_8)); encode(sign())
    }
    private fun encrypted(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keys.getKey("bungee-storage", null) as SecretKey)
        val data = cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        return encode(data)
    }
    private fun putSecret(name: String, text: String) = synchronized(identityInitialization) { check(currentIdentity()) { "Pairing was reset; reopen Bungee" }; check(prefs.edit().putString(name, encrypted(text)).commit()) { "Could not persist encrypted identity" } }
    private fun secret(name: String): String? = prefs.getString(name, null)?.let {
        val data = Base64.decode(it, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keys.getKey("bungee-storage", null) as SecretKey, GCMParameterSpec(128, data.copyOfRange(0, 12)))
        cipher.doFinal(data.copyOfRange(12, data.size)).toString(Charsets.UTF_8)
    }
    companion object {
        private const val COMMAND_CONSENT = "recovery_command_consent_v2"
        private val identityInitialization = Any()
        private val locationPreference = CheckedPreference(failureValue = false)
        private val commandPreference = CheckedPreference(failureValue = false)
        private val appLockPreference = CheckedPreference(failureValue = true)
        fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
        /** Does not construct/decrypt a broken Identity when fresh keys are requested. */
        fun resetExisting(context: Context, newKeys: Boolean) = PrivacySends.fence.change { synchronized(identityInitialization) { synchronized(GpsStorage.lock) {
            check(LocalSafety.isStopped(context)) { "Stop Bungee before resetting pairing" }
            check(!ManagementAgent.blocksPersonalOperation(context)) { "Android ownership must be resolved first; keys were preserved" }
            val prefs = context.getSharedPreferences("identity", Context.MODE_PRIVATE)
            val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val keep = if (newKeys) null else {
                val existing = Identity(context)
                check(existing.wgPrivate.isNotEmpty() && existing.publicKey.isNotEmpty())
                prefs.getString("wg_private", null) to existing.wgPublic
            }
            val lock = runCatching { prefs.getBoolean("app_lock", false) }.getOrDefault(true)
            GpsStorage.reset(context)
            val edit = prefs.edit().clear().putString("identity_generation", java.util.UUID.randomUUID().toString()).putBoolean("app_lock", lock)
            keep?.let { edit.putString("wg_private", it.first).putString("wg_public", it.second) }
            check(edit.commit()) { "Could not reset Bungee's pairing state" }
            if (newKeys) { keys.deleteEntry("bungee-signing"); keys.deleteEntry("bungee-storage") }
        } } }
        /** Read legacy recovery records without generating/replacing a key or changing identity state. */
        fun readExistingState(context: Context, name: String): JSONObject {
            val value = context.getSharedPreferences("identity", Context.MODE_PRIVATE).getString("state_$name", null) ?: return JSONObject()
            val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val key = keys.getKey("bungee-storage", null) as? SecretKey ?: error("Existing storage key unavailable")
            val bytes = Base64.decode(value, Base64.NO_WRAP)
            require(bytes.size >= 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            return JSONObject(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8))
        }
    }
}
