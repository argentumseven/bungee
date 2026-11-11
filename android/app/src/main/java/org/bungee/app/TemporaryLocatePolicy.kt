package org.bungee.app

/** A bounded recovery request can use approved GPS without enabling passive collection. */
object TemporaryLocatePolicy {
    fun allowed(passiveConsent: Boolean, command: Boolean, recoveryConsent: Boolean, permission: Boolean, foregroundService: Boolean) =
        permission && foregroundService && if (command) recoveryConsent else passiveConsent
}
