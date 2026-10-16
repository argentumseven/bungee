package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import org.bungee.transport.Transport

class HomeApiException(val status: Int) : Exception("Home API rejected request")

class HomeApi(private val identity: Identity, val clock: HomeClock = HomeClock()) {
    private val bundle get() = JSONObject(checkNotNull(identity.bundle) { "Not paired" })
    fun enroll(capabilities: List<String>) {
        val token = bundle.optString("token", "")
        val proof = "BUNGEE-ENROLL-V1\n$token\n${identity.wgPublic}\n${identity.publicKey}"
        val body = JSONObject().put("token", token).put("public_key", identity.publicKey)
            .put("wg_public_key", identity.wgPublic).put("proof", identity.sign(proof)).put("capabilities", JSONArray(capabilities))
        val result = try { request("/v1/enroll", body, signed = false) }
        catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // The one-use redemption may have committed before its response was lost.
            // This succeeds only if the server already bound THIS signing key to this device ID.
            val existing = request("/v1/sync", JSONObject().put("report", JSONObject()))
            require(existing.has("revision") && existing.has("policy")) { "Registration could not be confirmed" }
            JSONObject().put("device_id", bundle.getString("device_id"))
        }
        require(result.getString("device_id") == bundle.getString("device_id"))
        identity.enrolled = true
        identity.bundle = bundle.apply { remove("token") }.toString()
    }
    fun request(path: String, body: JSONObject = JSONObject(), signed: Boolean = true): JSONObject {
        check(HomeTunnel.state == com.wireguard.android.backend.Tunnel.State.UP) { "The private tunnel is disconnected" }
        require(path in listOf("/v1/enroll", "/v1/telemetry", "/v1/commands", "/v1/ack", "/v1/sync"))
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val headers = JSONObject()
        if (signed) {
            val timestamp = (System.currentTimeMillis() / 1000).toString()
            val nonce = UUID.randomUUID().toString()
            val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val signature = identity.sign("BUNGEE-V1\nPOST\n$path\n$timestamp\n$nonce\n$hash")
            headers.put("X-Bungee-Device", bundle.getString("device_id"))
            headers.put("X-Bungee-Time", timestamp)
            headers.put("X-Bungee-Nonce", nonce)
            headers.put("X-Bungee-Signature", signature)
        }
        check(HomeTunnel.appContained) { "The app-contained connection is unavailable" }
        val started = android.os.SystemClock.elapsedRealtime()
        val response = JSONObject(Transport.exchange(path, body.toString(), headers.toString()))
        val status = response.getInt("status")
        val result = JSONObject(response.getString("body"))
        if (status !in 200..299) throw HomeApiException(status)
        if (result.optLong("server_time", 0) > 0) clock.observe(result.getLong("server_time"), started, android.os.SystemClock.elapsedRealtime())
        return result
    }
}
