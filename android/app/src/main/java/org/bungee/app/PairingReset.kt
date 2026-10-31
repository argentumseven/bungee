package org.bungee.app

/** Stop first, then discard only Bungee state. No Android policy mutation belongs here. */
object PairingReset {
    fun run(role: () -> ManagementRole, stop: () -> Unit, erase: () -> Unit, ready: () -> Unit) {
        check(role() == ManagementRole.PERSONAL) { "Resolve Bungee's Android ownership before resetting pairing. Keys were preserved." }
        stop()
        check(role() == ManagementRole.PERSONAL) { "Android management status changed. Keys were preserved." }
        erase()
        ready() // Never clear the saved stop if erasure or new-key initialization fails.
    }
}

/** Explicit legacy repair; never tries to remove a managed profile or erase a phone. */
object OwnershipRepair {
    fun run(role: () -> ManagementRole, releasePolicies: () -> List<String>, releaseOwner: () -> Unit): List<String> {
        return when (role()) {
            ManagementRole.UNKNOWN -> listOf("Android management status is unavailable. No ownership changes were attempted.")
            ManagementRole.PROFILE_OWNER -> listOf("Bungee is a profile owner. This repair does not remove profiles or their data. Use the Android management path for this profile; pairing keys were preserved.")
            ManagementRole.PERSONAL -> releasePolicies()
            ManagementRole.DEVICE_OWNER -> {
                val issues = releasePolicies()
                if (issues.isNotEmpty()) issues
                else {
                    check(role() == ManagementRole.DEVICE_OWNER) { "Android ownership changed during repair; check its status again" }
                    releaseOwner()
                    if (role() == ManagementRole.PERSONAL) emptyList()
                    else listOf("Android has not confirmed removal of Bungee ownership. Pairing keys were preserved; check status again.")
                }
            }
        }
    }
}
