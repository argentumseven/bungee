package org.bungee.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.wireguard.crypto.KeyPair
import org.json.JSONObject
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
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
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
        set(value) { prefs.edit().putBoolean("enrolled", value).commit() }
    var appLock: Boolean
        get() = prefs.getBoolean("app_lock", false)
        set(value) { prefs.edit().putBoolean("app_lock", value).commit() }
    var allowLocate: Boolean
        get() = prefs.getBoolean("allow_locate", true)
        set(value) { prefs.edit().putBoolean("allow_locate", value).commit() }
    var allowCommands: Boolean
        get() = prefs.getBoolean("allow_commands", true)
        set(value) { prefs.edit().putBoolean("allow_commands", value).commit() }
    var recoveryMessage: String?
        get() = secret("recovery_message")
        set(value) { if (value == null) prefs.edit().remove("recovery_message").commit() else putSecret("recovery_message", value) }
    fun result(id: String): JSONObject? = secret("receipt_$id")?.let(::JSONObject)
    fun saveResult(id: String, result: JSONObject) {
        // Commands are at-most-once on this phone, including across service/process restarts.
        putSecret("receipt_$id", result.toString())
        val ids = prefs.getStringSet("receipts", emptySet())!!.toMutableSet().apply { add(id) }
        if (ids.size > 100) ids.first().let { ids.remove(it); prefs.edit().remove("receipt_$it").commit() }
        prefs.edit().putStringSet("receipts", ids).commit()
    }
    fun sign(text: String): String = Signature.getInstance("SHA256withECDSA").run {
        initSign(keys.getKey("bungee-signing", null) as java.security.PrivateKey); update(text.toByteArray(Charsets.UTF_8)); encode(sign())
    }
    fun reset() {
        prefs.edit().clear().commit()
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
    companion object { fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP) }
}
