package org.bungee.app

import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** Reads only the retired controller's undo record; independent of pairing/network access. */
object LegacyDnsRecovery {
    private fun prefs(context: Context) = context.getSharedPreferences("private-dns-control", Context.MODE_PRIVATE)
    fun pending(context: Context) = prefs(context).contains("state")
    @Synchronized fun restore(context: Context) {
        if (!pending(context)) return
        LegacyDnsCleanup(object : LegacyDnsStore {
            override fun read(): LegacyDnsState {
                val j = JSONObject(prefs(context).getString("state", null)!!)
                fun nullable(j: JSONObject, key: String) = if (j.isNull(key)) null else j.getString(key)
                val baseline = j.optJSONObject("baseline")?.let { LegacyDnsSettings(nullable(it, "mode"), nullable(it, "hostname")) }
                return LegacyDnsState(j.optBoolean("owned"), j.optString("hostname"), j.optString("status"), baseline)
            }
            override fun markRestoring() {
                val j = JSONObject(prefs(context).getString("state", null)!!).put("status", "restoring")
                check(prefs(context).edit().putString("state", j.toString()).commit()) { "Could not save DNS recovery progress" }
            }
            override fun clear() { check(prefs(context).edit().remove("state").commit()) { "Could not clear completed DNS recovery" } }
        }, object : LegacyDnsSettingsAccess {
            override fun permitted() = ContextCompat.checkSelfPermission(context, "android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED
            override fun read() = LegacyDnsSettings(Settings.Global.getString(context.contentResolver, "private_dns_mode"), Settings.Global.getString(context.contentResolver, "private_dns_specifier"))
            override fun write(value: LegacyDnsSettings) {
                check(permitted())
                check(Settings.Global.putString(context.contentResolver, "private_dns_mode", "opportunistic"))
                check(Settings.Global.putString(context.contentResolver, "private_dns_specifier", value.hostname))
                check(Settings.Global.putString(context.contentResolver, "private_dns_mode", value.mode))
            }
        }).restore()
    }
}
