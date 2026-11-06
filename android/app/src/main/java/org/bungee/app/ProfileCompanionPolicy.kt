package org.bungee.app

import org.json.JSONObject

/** A linked installation handles only actions and camera events in its Android user. */
object ProfileCompanionPolicy {
    val commands = setOf("message", "clear_message", "stop_all")
    fun isCompanion(bundle: JSONObject): Boolean {
        if (bundle.isNull("profile")) return false
        val profile = bundle.getJSONObject("profile")
        val companion = profile.getString("role") == "companion"
        require(companion || profile.getString("role") == "main") { "Unsupported profile role" }
        val parent = profile.getString("primary_device_id")
        require(runCatching { java.util.UUID.fromString(parent).toString() == parent }.getOrDefault(false) && (if (companion) parent != bundle.optString("device_id") else parent == bundle.optString("device_id"))) { "Invalid primary phone" }
        return companion
    }
    fun permits(companion: Boolean, command: String) = !companion || command in commands
}
