package org.bungee.app

import org.json.JSONObject

data class DevicePolicy(
    val managedDns: Boolean = false, val autoResume: Boolean = false,
    val alwaysOn: Boolean = false, val protectSettings: Boolean = false,
    val preventUninstall: Boolean = false, val requireStrongLock: Boolean = false,
    val blockedApps: Set<String> = emptySet(), val lostMode: Boolean = false,
    val recoveryMessage: String = ""
) {
    companion object {
        fun safePackage(name: String) = name.length <= 160 && name.contains('.') && name != "org.bungee.app" && name != "android" && !name.startsWith("com.android.") && name.split('.').all { it.matches(Regex("[A-Za-z][A-Za-z0-9_]*")) }
        fun parse(json: JSONObject): DevicePolicy {
            require(!json.optBoolean("managed_dns") || json.optBoolean("always_on")) { "Managed DNS requires always-on VPN" }
            val packages = json.optJSONArray("blocked_apps")
            require((packages?.length() ?: 0) <= 20) { "Too many managed packages" }
            val blocked = (0 until (packages?.length() ?: 0)).map { packages!!.getString(it) }.toSet()
            require(blocked.all(::safePackage)) { "Core Android and Bungee packages cannot be suspended" }
            val message = json.optString("recovery_message", "")
            require(message.codePointCount(0, message.length) <= 240 && message.none { it.isISOControl() && it != '\n' }) { "Invalid recovery message" }
            val lost = json.optBoolean("lost_mode")
            require(!lost || message.isNotBlank()) { "Lost mode needs a recovery message" }
            return DevicePolicy(json.optBoolean("managed_dns"), json.optBoolean("auto_resume"), json.optBoolean("always_on"), json.optBoolean("protect_settings"), json.optBoolean("prevent_uninstall"), json.optBoolean("require_strong_lock"), blocked, lost, message)
        }
    }
}
