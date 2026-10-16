package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DevicePolicyTest {
    @Test fun personalModeDoesNotEnableAnyManagedControlByDefault() {
        val policy = DevicePolicy.parse(JSONObject())
        assertFalse(policy.managedDns); assertFalse(policy.alwaysOn); assertFalse(policy.protectSettings)
        assertFalse(policy.preventUninstall); assertFalse(policy.lostMode); assertTrue(policy.blockedApps.isEmpty())
    }
    @Test fun managedDnsNeedsAlwaysOnAndSelectedAppsAreBounded() {
        assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put("managed_dns", true)) }
        val policy = DevicePolicy.parse(JSONObject().put("managed_dns", true).put("always_on", true)
            .put("blocked_apps", JSONArray(listOf("org.mozilla.firefox"))))
        assertTrue(policy.managedDns); assertEquals(setOf("org.mozilla.firefox"), policy.blockedApps)
        for (name in listOf("com.android.settings", "android", "org.bungee.app", "bad;name.app")) {
            assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put("blocked_apps", JSONArray(listOf(name)))) }
        }
    }
    @Test fun lostModeNeedsAReadableBoundedContactMessage() {
        assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put("lost_mode", true)) }
        assertThrows(IllegalArgumentException::class.java) { DevicePolicy.parse(JSONObject().put("recovery_message", "x".repeat(241))) }
        assertTrue(DevicePolicy.parse(JSONObject().put("lost_mode", true).put("recovery_message", "Please call the household")).lostMode)
    }
}
