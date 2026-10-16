package org.bungee.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.wireguard.crypto.KeyPair
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
    private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    init {
        if (!keys.containsAlias("bungee-signing")) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder("bungee-signing", KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
            }.generateKeyPair()
        }
        if (!keys.containsAlias("bungee-storage")) {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder("bungee-storage", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
        }
        if (!prefs.contains("wg_private")) {
            val pair = KeyPair()
            putSecret("wg_private", pair.privateKey.toBase64())
            prefs.edit().putString("wg_public", pair.publicKey.toBase64()).commit()
        }
    }
    val wgPublic: String get() = prefs.getString("wg_public", "")!!
    val wgPrivate: String get() = secret("wg_private")!!
    val publicKey: String get() = encode(keys.getCertificate("bungee-signing").publicKey.encoded)
    var bundle: String?
        get() = secret("bundle")
        set(value) { if (value == null) prefs.edit().remove("bundle").commit() else putSecret("bundle", value) }
    var enrolled: Boolean
        get() = prefs.getBoolean("enrolled", false)
        set(value) { check(prefs.edit().putBoolean("enrolled", value).commit()) { "Could not persist enrollment state" } }
    var appLock: Boolean
        get() = prefs.getBoolean("app_lock", false)
        set(value) { prefs.edit().putBoolean("app_lock", value).commit() }
    var allowLocate: Boolean
        get() = prefs.getBoolean("allow_locate", true)
        set(value) {
            synchronized(GpsStorage.lock) {
                // Persist withdrawal before cleanup. A cleanup failure cannot authorize uploads.
                // Clear again before re-enabling if a previous cleanup was interrupted.
                if (value && !allowLocate) newJournal().clear()
                val edit = prefs.edit().putBoolean("allow_locate", value)
                if (!value) edit.remove("location_queue").remove("gps_backlog_v2")
                check(edit.commit()) { "Could not save location consent and queue state" }
                if (!value) newJournal().clear()
            }
        }
    var allowCommands: Boolean
        get() = prefs.getBoolean("allow_commands", true)
        set(value) { prefs.edit().putBoolean("allow_commands", value).commit() }
    internal fun state(name: String): JSONObject = secret("state_$name")?.let(::JSONObject) ?: JSONObject()
    internal fun saveState(name: String, value: JSONObject) = putSecret("state_$name", value.toString())
    var recoveryMessage: String?
        get() = secret("recovery_message")
        set(value) { if (value == null) prefs.edit().remove("recovery_message").commit() else putSecret("recovery_message", value) }
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
    fun queueLocation(point: JSONObject) = synchronized(GpsStorage.lock) {
        if (!allowLocate || !GpsBacklog.usable(point)) return
        journal().append(point)
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
    fun acknowledgeLocations(sent: JSONArray) = synchronized(GpsStorage.lock) { journal().acknowledge(sent) }
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
    fun reset() = synchronized(GpsStorage.lock) {
        newJournal().clear()
        check(prefs.edit().clear().commit()) { "Could not erase local identity" }
        keys.deleteEntry("bungee-signing"); keys.deleteEntry("bungee-storage")
    }
    private fun putSecret(name: String, text: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keys.getKey("bungee-storage", null) as SecretKey)
        val data = cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString(name, encode(data)).commit()) { "Could not persist encrypted identity" }
    }
    private fun secret(name: String): String? = prefs.getString(name, null)?.let {
        val data = Base64.decode(it, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keys.getKey("bungee-storage", null) as SecretKey, GCMParameterSpec(128, data.copyOfRange(0, 12)))
        cipher.doFinal(data.copyOfRange(12, data.size)).toString(Charsets.UTF_8)
    }
    companion object {
        fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
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
