package org.bungee.app
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
class AppReleaseTest {
    private fun manifest()=JSONObject().put("version","1.1.9").put("version_code",25).put("sha256","a".repeat(64)).put("signer_sha256","b".repeat(64)).put("size",100000000)
    @Test fun onlyNewerVersionWithSameSigningIdentityCanUpdate() {
        val release=AppRelease.parse(manifest())
        assertTrue(release.compatible(24,"b".repeat(64)))
        assertFalse(release.compatible(25,"b".repeat(64)))
        assertFalse(release.compatible(26,"b".repeat(64)))
        assertFalse(release.compatible(24,"c".repeat(64)))
    }
    @Test fun metadataRejectsUnboundedStorageAndInvalidDigests() {
        for(input in listOf(manifest().put("size",0),manifest().put("size",300000000),manifest().put("sha256","../file"),manifest().put("version_code",0))) {
            try {AppRelease.parse(input);fail("Invalid manifest accepted")} catch(_:IllegalArgumentException) {}
        }
    }
}
