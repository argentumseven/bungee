package org.bungee.app

import java.security.MessageDigest

/** The raw Android user ID is never sent or retained by the server. */
object ProfileIdentity {
    fun fingerprint(androidUserId: String, homePublicKey: String, phoneId: String): String =
        MessageDigest.getInstance("SHA-256").digest("BUNGEE-PROFILE-V1\n$androidUserId\n$homePublicKey\n$phoneId".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
