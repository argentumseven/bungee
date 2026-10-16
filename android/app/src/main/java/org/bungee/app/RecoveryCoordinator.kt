package org.bungee.app

/** Run every independent cleanup even when preferences, Keystore or one Android API fails. */
object RecoveryCoordinator {
    fun run(quarantine: () -> Unit, actions: List<Pair<String, () -> Unit>>): List<String> {
        val failures = mutableListOf<String>()
        try { quarantine() } catch (_: Exception) { failures += "The local stop could not be saved. Use Android Settings to force-stop Bungee." }
        for ((label, action) in actions) {
            try { action() } catch (_: Exception) { failures += label }
        }
        return failures
    }
}
