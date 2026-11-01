package org.bungee.app

import android.content.Context
import android.net.ConnectivityManager
import org.json.JSONArray
import org.json.JSONObject

/** OS configuration only. No packet capture, VPN service or resolver override. */
object DnsPathStatus {
    fun report(context: Context): JSONObject {
        val result=JSONObject().put("captured_by_bungee",false).put("available",false)
            .put("servers",JSONArray()).put("private_dns_active",false).put("private_dns_name",JSONObject.NULL)
        runCatching {
            val manager=context.getSystemService(ConnectivityManager::class.java)
            val properties=manager.getLinkProperties(manager.activeNetwork) ?: return result
            result.put("available",true).put("servers",JSONArray(properties.dnsServers.take(4).mapNotNull { it.hostAddress }))
                .put("private_dns_active",properties.isPrivateDnsActive)
                .put("private_dns_name",properties.privateDnsServerName ?: JSONObject.NULL)
        }
        return result
    }
    fun describe(report: JSONObject): String {
        if(!report.optBoolean("available"))return "Android DNS configuration is unavailable. Bungee captures no other-app DNS."
        val servers=report.getJSONArray("servers")
        val list=(0 until servers.length()).joinToString(", ") { servers.getString(it) }.ifEmpty { "none reported" }
        val name=report.optString("private_dns_name","").takeIf { it!="null" && it.isNotEmpty() }
        return "Android-reported DNS: $list. Private DNS: ${if(report.optBoolean("private_dns_active")) name ?: "active (automatic)" else "not active"}. Bungee captures no other-app DNS."
    }
}
