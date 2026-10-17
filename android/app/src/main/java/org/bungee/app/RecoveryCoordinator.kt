package org.bungee.app

/** Run every independent cleanup even when preferences, Keystore or one Android API fails. */
object RecoveryCoordinator {
    fun run(quarantine: () -> Unit, actions: List<Pair<String, () -> Unit>>): List<String> {
        val failures = mutableListOf<String>()
        try { quarantine() } catch (_: Exception) { failures += "The local stop could not be saved. Deactivate Bungee administration, then force-stop it in Android Settings." }
        for ((label, action) in actions) {
            try { action() } catch (_: Exception) { failures += label }
        }
        return failures
    }
}
