package org.bungee.app

import org.json.JSONObject
import java.util.UUID

/** Encrypted checkpoint, never authority to create a camera service from a boot receiver. */
class CameraLease(val id: String, val boot: Int, val gate: FailedUnlockGate) {
    fun snapshot() = JSONObject().put("id", id).put("boot", boot).put("gate", gate.snapshot())
    companion object {
        fun obtain(saved: JSONObject, boot: Int, elapsed: Long, failures: Int, visibleStart: Boolean): CameraLease {
            require(boot >= 0 && elapsed >= 0)
            if (saved.length() != 0 && saved.getInt("boot") == boot) {
                val id = saved.getString("id")
                require(UUID.fromString(id).toString() == id)
                return CameraLease(id, boot, FailedUnlockGate.restore(saved.getJSONObject("gate"), elapsed))
            }
            check(visibleStart) { "Open Bungee after reboot to resume camera protection" }
            return CameraLease(UUID.randomUUID().toString(), boot, FailedUnlockGate().apply { reset(failures) })
        }
    }
}
