package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import org.bungee.transport.Transport

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
        if (HomeTunnel.appContained) {
            val response = JSONObject(Transport.exchange(path, body.toString(), headers.toString()))
            val status = response.getInt("status")
            val result = JSONObject(response.getString("body"))
            if (status !in 200..299) error(result.optString("error", "Server rejected request ($status)"))
            return result
        }
        val connection = URL("http://10.77.0.1:8081$path").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"; connection.connectTimeout = 10000; connection.readTimeout = 10000
        connection.instanceFollowRedirects = false; connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        headers.keys().forEach { connection.setRequestProperty(it, headers.getString(it)) }
        try {
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { source ->
                val result = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = source.read(buffer)
                    if (count < 0) break
                    check(result.size() + count <= 65536) { "Server response is too large" }
                    result.write(buffer, 0, count)
                }
                result.toString("UTF-8")
            } ?: "{}"
            if (status !in 200..299) throw IllegalStateException(JSONObject(text).optString("error", "Server rejected request ($status)"))
            return JSONObject(text)
        } finally { connection.disconnect() }
    }
}
