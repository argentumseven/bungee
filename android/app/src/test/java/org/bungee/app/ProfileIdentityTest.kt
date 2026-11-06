package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class ProfileIdentityTest {
    @Test fun identityIsStableButScopedToAndroidUserHomeAndPhysicalPhone() {
        val fingerprint=ProfileIdentity.fingerprint("user-one","home-one","phone-one")
        assertEquals(64,fingerprint.length)
        assertEquals(fingerprint,ProfileIdentity.fingerprint("user-one","home-one","phone-one"))
        assertNotEquals(fingerprint,ProfileIdentity.fingerprint("user-two","home-one","phone-one"))
        assertNotEquals(fingerprint,ProfileIdentity.fingerprint("user-one","home-two","phone-one"))
        assertNotEquals(fingerprint,ProfileIdentity.fingerprint("user-one","home-one","phone-two"))
    }
}
