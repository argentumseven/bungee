package org.bungee.app

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AppUpdateStateTest {
    private val signer="b".repeat(64)
    private val release=AppRelease("1.1.11",27,"a".repeat(64),signer,1024*1024)
    private fun observe(state: AppUpdateStatus, incoming: AppRelease?=release, explicit: Boolean=false) = state.observed(incoming,"1.1.11",null,25,signer,explicit)

    @Test fun checkingIsDistinctFromDownloadingAndAlwaysHasAResult() {
        val checking=AppUpdateStatus(phase=AppUpdatePhase.CHECKING)
        assertTrue(checking.busy);assertNull(checking.progress)
        val available=observe(checking,explicit=true)
        assertEquals(AppUpdatePhase.AVAILABLE,available.phase)
        assertEquals("1.1.11",available.serverVersion);assertTrue(available.canDownload)
    }
    @Test fun changedSignerBlocksANewerUpdateWithoutMisreportingMatchingVersions() {
        for(code in listOf(25L,27L,28L)) {
            val result=AppUpdateStatus().observed(release,"1.1.11",null,code,"c".repeat(64),true)
            assertEquals(if(code<release.code) AppUpdatePhase.BLOCKED else AppUpdatePhase.CURRENT,result.phase)
            assertFalse(result.canDownload)
            if(code==release.code) assertTrue(result.message.contains("up to date"))
            if(code<release.code) assertTrue(result.message.contains("signing certificates differ"))
            assertTrue(result.signerMismatch)
            assertTrue(result.copy(phase=AppUpdatePhase.ERROR).signerMismatch)
            assertEquals(result,result.observed(release,"1.1.11",null,code,"c".repeat(64),true))
        }
    }
    @Test fun syncCannotHideCheckDownloadVerificationPausedOrErrors() {
        for(phase in listOf(AppUpdatePhase.CHECKING,AppUpdatePhase.DOWNLOADING,AppUpdatePhase.VERIFYING,AppUpdatePhase.PAUSED,AppUpdatePhase.ERROR,AppUpdatePhase.READY)) {
            val state=AppUpdateStatus(release,"1.1.11",phase,"Persistent status",524288,signer)
            assertEquals(state,observe(state))
        }
        val downloading=AppUpdateStatus(release,phase=AppUpdatePhase.DOWNLOADING,downloadedBytes=524288)
        assertEquals(50,downloading.progress);assertEquals(downloading,observe(downloading,null))
        assertEquals(AppUpdatePhase.AVAILABLE,observe(AppUpdateStatus(release,phase=AppUpdatePhase.PAUSED),explicit=true).phase)
    }
    @Test fun preparationFailureIsVisibleAndDoesNotLookUpToDate() {
        val state=AppUpdateStatus().observed(null,"1.1.11",JSONObject().put("message","Restore the original signing key"),25,signer,true)
        assertEquals(AppUpdatePhase.PREPARING,state.phase);assertEquals("1.1.11",state.serverVersion)
        assertEquals("Restore the original signing key",state.message);assertFalse(state.canDownload)
    }
    @Test fun sameSignerAndNewerCodeAreRequiredForDownloadAndNewServerInvalidatesPausedFile() {
        val current=AppUpdateStatus().observed(release,"1.1.11",null,27,signer)
        assertFalse(current.canDownload)
        assertFalse(current.copy(phase=AppUpdatePhase.ERROR).canDownload)
        assertFalse(AppUpdateStatus().observed(release,"1.1.11",null,28,signer).canDownload)
        val paused=AppUpdateStatus(release,phase=AppUpdatePhase.PAUSED,installedSigner=signer,updateAvailable=true)
        assertTrue(paused.canDownload)
        val updated=observe(paused,release.copy(version="1.1.12",code=28,sha="d".repeat(64)))
        assertEquals(AppUpdatePhase.AVAILABLE,updated.phase);assertEquals(0L,updated.downloadedBytes)
    }
}
