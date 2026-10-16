package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

class HomeApi(private val identity: Identity) {
    private val bundle get() = JSONObject(checkNotNull(identity.bundle) { "Not paired" })
    fun enroll(capabilities: List<String>) {
        val token = bundle.getString("token")
        val proof = "BUNGEE-ENROLL-V1\n$token\n${identity.wgPublic}\n${identity.publicKey}"
        val body = JSONObject().put("token", token).put("public_key", identity.publicKey)
            .put("wg_public_key", identity.wgPublic).put("proof", identity.sign(proof)).put("capabilities", JSONArray(capabilities))
        val result = request("/v1/enroll", body, signed = false)
        require(result.getString("device_id") == bundle.getString("device_id"))
        identity.enrolled = true
        identity.bundle = bundle.apply { remove("token") }.toString()
    }
    fun request(path: String, body: JSONObject = JSONObject(), signed: Boolean = true): JSONObject {
        check(HomeTunnel.state == com.wireguard.android.backend.Tunnel.State.UP) { "The private tunnel is disconnected" }
        require(path in listOf("/v1/enroll", "/v1/telemetry", "/v1/commands", "/v1/ack"))
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val connection = URL("http://10.77.0.1:8081$path").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"; connection.connectTimeout = 10000; connection.readTimeout = 10000
        connection.instanceFollowRedirects = false; connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        if (signed) {
            val timestamp = (System.currentTimeMillis() / 1000).toString()
            val nonce = UUID.randomUUID().toString()
            val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val signature = identity.sign("BUNGEE-V1\nPOST\n$path\n$timestamp\n$nonce\n$hash")
            connection.setRequestProperty("X-Bungee-Device", bundle.getString("device_id"))
            connection.setRequestProperty("X-Bungee-Time", timestamp)
            connection.setRequestProperty("X-Bungee-Nonce", nonce)
            connection.setRequestProperty("X-Bungee-Signature", signature)
        }
        try {
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText().take(65536) } ?: "{}"
            if (status !in 200..299) throw IllegalStateException(JSONObject(text).optString("error", "Server rejected request ($status)"))
            return JSONObject(text)
        } finally { connection.disconnect() }
    }
}
