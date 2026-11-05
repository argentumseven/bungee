package org.bungee.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProfileCompanionPolicyTest {
    @Test fun legacyPairingRemainsPrimaryAndCompanionRequiresASeparateValidParent() {
        assertFalse(ProfileCompanionPolicy.isCompanion(JSONObject().put("device_id","legacy")))
        val parent="33201124-a4e7-44d7-b07f-cf17fd11c8e7"
        val bundle=JSONObject().put("device_id","2891420d-12ef-4de9-baf3-81a6ce9c7942")
            .put("profile",JSONObject().put("role","companion").put("primary_device_id",parent))
        assertTrue(ProfileCompanionPolicy.isCompanion(bundle))
        bundle.getJSONObject("profile").put("primary_device_id",bundle.getString("device_id"))
        assertThrows(IllegalArgumentException::class.java){ProfileCompanionPolicy.isCompanion(bundle)}
        bundle.getJSONObject("profile").put("primary_device_id",parent).put("role","primary")
        assertThrows(IllegalArgumentException::class.java){ProfileCompanionPolicy.isCompanion(bundle)}
    }
    @Test fun forgedHardwareAndLocationCommandsCannotExecuteInACompanion() {
        for(kind in listOf("locate","best_guess","ring","ring_flash","flash","lock","reboot")) {
            assertFalse(kind,ProfileCompanionPolicy.permits(true,kind))
            assertTrue(kind,ProfileCompanionPolicy.permits(false,kind))
        }
        for(kind in listOf("message","clear_message","stop_all")) assertTrue(ProfileCompanionPolicy.permits(true,kind))
    }
}
