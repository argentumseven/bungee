package org.bungee.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import org.json.JSONObject
import kotlin.math.abs

/** Signed API probes, not packet loss or reachability of unrelated Internet services. */
object ConnectionHealth {
    private val since=System.currentTimeMillis()/1000
    private var attempts=0L; private var succeeded=0L; private var last: Long?=null
    private var mean=0.0; private var jitter=0.0
    @Synchronized fun success(rtt: Long) {
        attempts++; succeeded++
        mean=if (succeeded==1L) rtt.toDouble() else mean*0.8+rtt*0.2
        last?.let { jitter=jitter*0.8+abs(rtt-it)*0.2 }; last=rtt
    }
    @Synchronized fun failed() { attempts++ }
    @Synchronized fun report(context: Context): JSONObject {
        val cm=context.getSystemService(ConnectivityManager::class.java)
        val caps=runCatching { cm.getNetworkCapabilities(cm.activeNetwork) }.getOrNull()
        val kind=when {
            caps==null -> "offline"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val vpn=runCatching { cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN)==true } }.getOrNull()
        val signal=caps?.signalStrength?.takeIf { it in -150..0 } ?: runCatching {
            if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)==true)
                context.applicationContext.getSystemService(android.net.wifi.WifiManager::class.java).connectionInfo.rssi.takeIf { it in -126..-1 }
            else null
        }.getOrNull()
        return JSONObject().put("since",since).put("reported_at",System.currentTimeMillis()/1000)
            .put("connection",kind).put("system_vpn",vpn ?: JSONObject.NULL)
            .put("signal_dbm",signal ?: JSONObject.NULL).put("attempts",attempts).put("succeeded",succeeded)
            .put("last_rtt_ms",last ?: JSONObject.NULL).put("mean_rtt_ms",mean.toLong()).put("jitter_ms",jitter.toLong())
    }
    fun systemVpn(context: Context): Any = report(context).get("system_vpn")
}
