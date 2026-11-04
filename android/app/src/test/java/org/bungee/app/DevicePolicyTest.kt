package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DevicePolicyTest {
    @Test fun hasteNeedsLostModeAndDefaultsToOff() {
        assertFalse(DevicePolicy.parse(JSONObject()).haste)
        assertFalse(DevicePolicy.parse(JSONObject().put("haste",true)).haste)
        assertTrue(DevicePolicy.parse(JSONObject().put("lost_mode",true).put("haste",true).put("recovery_message","Call home")).haste)
    }
    @Test fun personalModeDoesNotEnableAnyManagedControlByDefault() {
        val policy = DevicePolicy.parse(JSONObject())
        assertFalse(policy.alwaysOn); assertFalse(policy.protectSettings)
        assertFalse(policy.preventUninstall); assertFalse(policy.lostMode); assertTrue(policy.blockedApps.isEmpty())
    }
    @Test fun persistentControlsAreRejectedEvenIfAServerRequestsThem() {
        for (key in listOf("managed_dns", "always_on", "auto_resume", "protect_settings", "prevent_uninstall", "require_strong_lock")) {
            assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put(key, true)) }
        }
        for (name in listOf("org.mozilla.firefox", "com.android.settings", "android", "org.bungee.app", "bad;name.app")) {
            assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put("blocked_apps", JSONArray(listOf(name)))) }
        }
    }
    @Test fun lostModeNeedsAReadableBoundedContactMessage() {
        assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put("lost_mode", true)) }
        assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put("recovery_message", "x".repeat(241))) }
        assertTrue(DevicePolicy.parse(JSONObject().put("lost_mode", true).put("recovery_message", "Please call the household")).lostMode)
    }
}
