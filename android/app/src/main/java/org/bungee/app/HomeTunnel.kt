package org.bungee.app

import android.content.Context
import android.net.InetAddresses
import android.util.Base64
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import org.json.JSONObject
import java.io.ByteArrayInputStream
import org.bungee.transport.Transport

object HomeTunnel {
    private var backend: GoBackend? = null
    private var activeParameters: String? = null
    @Volatile var appContained: Boolean = false
        private set
    @Volatile var managedDnsActive: Boolean = false
        private set
    private val tunnel = object : Tunnel {
        override fun getName() = "bungee-home"
        override fun onStateChange(newState: Tunnel.State) { state = newState }
    }
    @Volatile var state: Tunnel.State = Tunnel.State.DOWN
        private set
    @Synchronized fun connect(context: Context, identity: Identity, bundle: JSONObject) {
        require(bundle.getInt("version") == 2) { "Re-pair using a version 2 invitation with a preshared key" }
        require(bundle.getString("api_url") == "http://10.77.0.1:8081") { "Unexpected device API address" }
        val wg = bundle.getJSONObject("wireguard")
        require(wg.getString("client_public_key") == identity.wgPublic) { "This invitation belongs to another phone" }
        require(wg.getString("allowed_ip") == "10.77.0.1/32") { "Only the home telemetry route is allowed" }
        require(wg.getString("address").matches(Regex("10\\.77\\.0\\.([2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])/32"))) { "Invalid phone tunnel address" }
        val endpoint = wg.getString("endpoint")
        val endpointHost = endpoint.substringBeforeLast(':').removeSurrounding("[", "]")
        val endpointPort = endpoint.substringAfterLast(':').toIntOrNull()
        require(InetAddresses.isNumericAddress(endpointHost) && endpointPort != null && endpointPort in 1..65535 && endpointPort != 51820) { "Use a numeric IP and a custom UDP port other than 51820; provider DNS is disabled" }
        val psk = wg.getString("preshared_key")
        require(psk.matches(Regex("[A-Za-z0-9+/]{43}=")) && Base64.decode(psk, Base64.NO_WRAP).any { it != 0.toByte() }) { "A unique 256-bit preshared key is required" }
        require(wg.getString("server_public_key").matches(Regex("[A-Za-z0-9+/]{43}="))) { "Invalid server key" }
        val managed = identity.managedDns && identity.managementConsent && ManagementAgent.isOwner(context)
        val useAndroidVpn = managed || (identity.managementConsent && ManagementAgent.isOwner(context) && identity.state("management").optJSONObject("policy")?.optBoolean("always_on") == true)
        val parameters = wg.toString() + ":managed-dns=" + managed + ":android-vpn=" + useAndroidVpn
        if (state == Tunnel.State.UP && activeParameters == parameters && (appContained || backend?.getState(tunnel) == Tunnel.State.UP)) return
        disconnect()
        if (!useAndroidVpn) {
            Transport.configure(JSONObject().put("address", wg.getString("address")).put("endpoint", endpoint)
                .put("private_key", identity.wgPrivate).put("public_key", wg.getString("server_public_key"))
                .put("preshared_key", psk).toString())
            appContained = true; state = Tunnel.State.UP; activeParameters = parameters
            return
        }
        val config = """
            [Interface]
            PrivateKey = ${identity.wgPrivate}
            Address = ${wg.getString("address")}
            ${if (managed) "DNS = 10.77.0.1" else "IncludedApplications = ${context.packageName}"}
            [Peer]
            PublicKey = ${wg.getString("server_public_key")}
            PresharedKey = $psk
            AllowedIPs = 10.77.0.1/32
            Endpoint = $endpoint
            PersistentKeepalive = 25
        """.trimIndent()
        val go = backend ?: GoBackend(context.applicationContext).also { backend = it }
        // Managed mode includes the profile's apps for the one home /32 and provides home DNS.
        // Ordinary non-home traffic stays outside the tunnel; no default route is installed.
        go.setState(tunnel, Tunnel.State.UP, Config.parse(ByteArrayInputStream(config.toByteArray())))
        activeParameters = parameters
        managedDnsActive = managed
    }
    @Synchronized fun disconnect() {
        try { backend?.setState(tunnel, Tunnel.State.DOWN, null) }
        finally { Transport.stop(); appContained = false; state = Tunnel.State.DOWN; activeParameters = null; managedDnsActive = false }
    }
}
