package org.bungee.app

import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import org.json.JSONObject

object PrivateDns {
    private fun control(context: Context) = PrivateDnsControl(object : PrivateDnsStore {
        private val prefs=context.getSharedPreferences("private-dns-control",Context.MODE_PRIVATE)
        override fun read(): PrivateDnsState {
            val j=JSONObject(prefs.getString("state","{}")!!)
            fun nullable(j:JSONObject,key:String)=if(j.isNull(key))null else j.optString(key).takeIf { it!="null" }
            val baseline=j.optJSONObject("baseline")?.let { DnsSettings(nullable(it,"mode"),nullable(it,"hostname")) }
            return PrivateDnsState(j.optBoolean("consent"),j.optLong("revision",-1),j.optString("hostname"),j.optBoolean("fallback",true),baseline,j.optBoolean("owned"),j.optString("status","disabled"),j.optString("detail","Normal Android DNS"))
        }
        override fun write(state: PrivateDnsState) {
            val j=JSONObject().put("consent",state.consent).put("revision",state.revision).put("hostname",state.hostname).put("fallback",state.fallback).put("owned",state.owned).put("status",state.status).put("detail",state.detail)
            state.baseline?.let { j.put("baseline",JSONObject().put("mode",it.mode?:JSONObject.NULL).put("hostname",it.hostname?:JSONObject.NULL)) }
            check(prefs.edit().putString("state",j.toString()).commit()) { "DNS recovery settings could not be saved" }
        }
    },object : PrivateDnsSettings {
        override fun permitted() = granted(context)
        override fun read() = DnsSettings(Settings.Global.getString(context.contentResolver,"private_dns_mode"),Settings.Global.getString(context.contentResolver,"private_dns_specifier"))
        override fun write(value: DnsSettings) {
            check(permitted()) { "ADB permission is missing; restore DNS in Android settings" }
            // Leave strict mode first; specifier changes must not strand the resolver between writes.
            check(Settings.Global.putString(context.contentResolver,"private_dns_mode","opportunistic"))
            check(Settings.Global.putString(context.contentResolver,"private_dns_specifier",value.hostname))
            check(Settings.Global.putString(context.contentResolver,"private_dns_mode",value.mode))
        }
    })
    fun granted(context: Context)=ContextCompat.checkSelfPermission(context,"android.permission.WRITE_SECURE_SETTINGS")==PackageManager.PERMISSION_GRANTED
    @Synchronized fun state(context:Context)=control(context).state()
    @Synchronized fun approve(context:Context){control(context).approve()}
    @Synchronized fun disable(context:Context,remove:Boolean=false){control(context).disable(remove)
        if(LocalSafety.isStopped(context))context.stopService(android.content.Intent(context,PrivateDnsService::class.java))
        else runCatching { PrivateDnsService.reportOff(context) }.onFailure { context.stopService(android.content.Intent(context,PrivateDnsService::class.java)) }}
    @Synchronized fun retry(context:Context){control(context).retry()}
    @Synchronized fun failed(context:Context){control(context).failed()}
    @Synchronized fun interrupted(context:Context){control(context).interrupted()}
    @Synchronized fun apply(context:Context,json:JSONObject){
        control(context).apply(PrivateDnsPolicy(json.getLong("revision"),json.getBoolean("enabled"),json.getBoolean("configured"),json.optString("hostname"),json.getBoolean("fallback"),json.getBoolean("removed")))
    }
    fun report(context:Context):JSONObject {
        val s=state(context)
        val state=if(s.status in listOf("disabled","active","fallback","permission_required","not_approved","error","removed"))s.status else "error"
        return JSONObject().put("revision",s.revision.coerceAtLeast(0)).put("state",state).put("active",s.owned&&state=="active").put("consent",s.consent).put("permission",granted(context)).put("detail",s.detail.take(160)).put("at",System.currentTimeMillis()/1000)
    }
}
