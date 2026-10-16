package org.bungee.app

import android.content.Context
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import org.json.JSONObject
import java.io.ByteArrayInputStream

object HomeTunnel {
    private var backend: GoBackend? = null
    private var activeParameters: String? = null
    private val tunnel = object : Tunnel {
        override fun getName() = "bungee-home"
        override fun onStateChange(newState: Tunnel.State) { state = newState }
    }
    @Volatile var state: Tunnel.State = Tunnel.State.DOWN
        private set
    @Synchronized fun connect(context: Context, identity: Identity, bundle: JSONObject) {
        require(bundle.getInt("version") == 1) { "Unsupported enrollment version" }
        require(bundle.getString("api_url") == "http://10.77.0.1:8081") { "Unexpected device API address" }
        val wg = bundle.getJSONObject("wireguard")
        require(wg.getString("client_public_key") == identity.wgPublic) { "This invitation belongs to another phone" }
        require(wg.getString("allowed_ip") == "10.77.0.1/32") { "Only the home telemetry route is allowed" }
        require(wg.getString("address").matches(Regex("10\\.77\\.0\\.([2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])/32"))) { "Invalid phone tunnel address" }
        val endpoint = wg.getString("endpoint")
        require(endpoint.matches(Regex("[A-Za-z0-9.-]+:[0-9]{1,5}")) && endpoint.substringAfterLast(':').toInt() in 1..65535) { "Invalid WireGuard endpoint" }
        require(wg.getString("server_public_key").matches(Regex("[A-Za-z0-9+/]{43}="))) { "Invalid server key" }
        if (backend?.getState(tunnel) == Tunnel.State.UP && activeParameters == wg.toString()) return
        val config = """
            [Interface]
            PrivateKey = ${identity.wgPrivate}
            Address = ${wg.getString("address")}
            IncludedApplications = ${context.packageName}
            [Peer]
            PublicKey = ${wg.getString("server_public_key")}
            AllowedIPs = 10.77.0.1/32
            Endpoint = $endpoint
            PersistentKeepalive = 25
        """.trimIndent()
        val go = backend ?: GoBackend(context.applicationContext).also { backend = it }
        // No default route, DNS override, proxy, NAT, or forwarding of general phone traffic.
        go.setState(tunnel, Tunnel.State.UP, Config.parse(ByteArrayInputStream(config.toByteArray())))
        activeParameters = wg.toString()
    }
    @Synchronized fun disconnect() { backend?.setState(tunnel, Tunnel.State.DOWN, null); activeParameters = null }
}
