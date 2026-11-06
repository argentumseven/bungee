package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class LegacyRuntimeWindowTest {
    @Test fun aNormalLegacyConnectionRetriesAfterTheServerCanHaveBeenUpgraded() {
        val window=LegacyRuntimeWindow()
        assertFalse(window.allows("phone",false,false,100))
        window.observeOldServer("phone",100)
        assertTrue(window.allows("phone",false,false,60099))
        assertFalse(window.allows("phone",false,false,60100))
        assertFalse(window.allows("another-phone",false,false,101))
    }
    @Test fun enablingProfilesImmediatelyStopsUsingTheLegacyCache() {
        val window=LegacyRuntimeWindow();window.observeOldServer("phone",100)
        assertFalse(window.allows("phone",true,false,101))
    }
    @Test fun anAcceptedRuntimeNeverFallsBackAndAnExplicitReconnectStartsFresh() {
        val window=LegacyRuntimeWindow();window.observeOldServer("phone",100)
        assertFalse(window.allows("phone",false,true,101))
        window.clear()
        assertFalse(window.allows("phone",false,false,102))
        window.observeOldServer("replacement",103)
        assertTrue(window.allows("replacement",false,false,104))
    }
}
