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
        val authorization = PrivacySends.fence.stamp()
        val token = bundle.optString("token", "")
        val proof = "BUNGEE-ENROLL-V1\n$token\n${identity.wgPublic}\n${identity.publicKey}"
        val body = JSONObject().put("token", token).put("public_key", identity.publicKey)
            .put("wg_public_key", identity.wgPublic).put("proof", identity.sign(proof)).put("capabilities", JSONArray(capabilities))
        val result = try { request("/v1/enroll", body, signed = false, authorization = authorization) }
        catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // The one-use redemption may have committed before its response was lost.
            // This succeeds only if the server already bound THIS signing key to this device ID.
            val existing = request("/v1/sync", JSONObject().put("report", JSONObject()), authorization = authorization)
            require(existing.has("revision") && existing.has("policy")) { "Registration could not be confirmed" }
            JSONObject().put("device_id", bundle.getString("device_id")).put("gps_epoch", existing.getString("gps_epoch"))
                .apply { existing.optString("photo_epoch").takeIf { it.isNotEmpty() }?.let { put("photo_epoch", it) } }
        }
        require(result.getString("device_id") == bundle.getString("device_id"))
        PrivacySends.fence.checked(authorization, { identity.requestsAllowed() }) {
            identity.reconcileGpsEpoch(result.getString("gps_epoch"))
            result.optString("photo_epoch").takeIf { it.isNotEmpty() }?.let { identity.reconcilePhotoEpoch(it) }
            identity.enrolled = true
            identity.bundle = bundle.apply { remove("token") }.toString()
        }
    }
    fun request(path: String, body: JSONObject = JSONObject(), signed: Boolean = true, reservation: Long? = null, timeoutMillis: Long = 10000, deadlineElapsed: Long = Long.MAX_VALUE, authorization: DisclosureFence.Stamp = PrivacySends.fence.stamp()): JSONObject {
        check(identity.requestsAllowed()) { "Bungee is stopped or its pairing changed; reopen the app" }
        check(HomeTunnel.state == com.wireguard.android.backend.Tunnel.State.UP) { "The private tunnel is disconnected" }
        require(path in listOf("/v1/enroll", "/v1/telemetry", "/v1/photos", "/v1/commands", "/v1/command-check", "/v1/dns-check", "/v1/ack", "/v1/sync"))
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
        val remaining = HomeRequestBudget.remaining(timeoutMillis, deadlineElapsed, started, path)
        val response = JSONObject(if (reservation == null) {
            DisclosureRequest(PrivacySends.fence, { Transport.reserveRequest() }, { Transport.cancelRequest(it) })
                .exchange(authorization, { identity.requestsAllowed() }, { minOf(remaining, deadlineElapsed - android.os.SystemClock.elapsedRealtime()) }) { request, budget ->
                    Transport.exchangeRequest(request, path, bytes.toString(Charsets.UTF_8), headers.toString(), budget)
                }
        } else Transport.exchangeRequest(reservation, path, bytes.toString(Charsets.UTF_8), headers.toString(), remaining))
        val status = response.getInt("status")
        if (status !in 200..299) throw HomeApiException(status)
        val result = JSONObject(response.getString("body"))
        if (result.optLong("server_time", 0) > 0) clock.observe(result.getLong("server_time"), started, android.os.SystemClock.elapsedRealtime())
        return result
    }
}
