package org.bungee.app

import android.content.Context
import android.net.InetAddresses
import android.util.Base64
import com.wireguard.android.backend.Tunnel
import org.json.JSONObject
import org.bungee.transport.Transport

object HomeTunnel {
    private var activeParameters: String? = null
    private var activeOwner: Any? = null
    @Volatile var appContained: Boolean = false
        private set
    @Volatile var state: Tunnel.State = Tunnel.State.DOWN
        private set
    @Synchronized fun connect(context: Context, identity: Identity, bundle: JSONObject, owner: Any? = null, claimExisting: Boolean = true) {
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
        check(!LocalSafety.isStopped(context)) { "Bungee is stopped locally" }
        check(!ManagementAgent.blocksPersonalOperation(context)) { "Open Bungee recovery. Device/profile ownership is unsupported" }
        check(identity.requestsAllowed()) { "Pairing changed; reopen Bungee" }
        val parameters = wg.toString()
        if (state == Tunnel.State.UP && appContained && activeParameters == parameters) { if (claimExisting) activeOwner = owner; return }
        disconnect()
        RecoveryConnection.current.open(
            { identity.requestsAllowed() },
            { Transport.configure(JSONObject().put("address", wg.getString("address")).put("endpoint", endpoint)
                .put("private_key", identity.wgPrivate).put("public_key", wg.getString("server_public_key"))
                .put("preshared_key", psk).toString()) },
            { disconnect() },
            { appContained = true; state = Tunnel.State.UP; activeParameters = parameters; activeOwner = owner }
        )
    }
    @Synchronized fun disconnectOwned(owner: Any) { if (activeOwner === owner) disconnect() }
    @Synchronized fun disconnect() {
        try { Transport.stop() }
        finally { RecoveryConnection.current.clear(); appContained = false; state = Tunnel.State.DOWN; activeParameters = null; activeOwner = null }
    }
}
