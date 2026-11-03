package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class PrivateDnsControlTest {
    private class Rig(initial:DnsSettings=DnsSettings(null,null)) : PrivateDnsStore {
        var saved=PrivateDnsState();var os=initial;var grant=true;var failSave=false;var failWrite=false
        val events=mutableListOf<String>()
        override fun read()=saved
        override fun write(state:PrivateDnsState){if(failSave)error("disk full");saved=state;events.add("save:${state.owned}:${state.status}")}
        // Resolve the two read signatures with a separate settings adapter.
        val settings=object:PrivateDnsSettings{
            override fun permitted()=grant
            override fun read()=os
            override fun write(value:DnsSettings){events.add("os:${value.mode}");if(failWrite)error("permission revoked");os=value}
        }
        val control=PrivateDnsControl(this,settings)
    }
    private fun on(revision:Long=1,fallback:Boolean=true)=PrivateDnsPolicy(revision,true,true,"abc.dns.example.org",fallback,false)
    @Test fun offAndRemovalRestoreExactPriorCustomSettingsBeforeDiscardingUndo(){
        val prior=DnsSettings("hostname","old.example.org");val r=Rig(prior)
        r.control.approve();r.control.apply(on());assertEquals(DnsSettings("hostname","abc.dns.example.org"),r.os)
        assertTrue(r.events.indexOf("save:true:error")<r.events.indexOf("os:hostname"))
        r.control.disable(true);assertEquals(prior,r.os);assertNull(r.saved.baseline);assertFalse(r.saved.owned);assertFalse(r.saved.consent);assertEquals("removed",r.saved.status)
    }
    @Test fun failureFallbackIsAutomaticAndLatchedButOffStillRestoresPriorDns(){
        val prior=DnsSettings("hostname","old.example.org");val r=Rig(prior);r.control.approve();r.control.apply(on());r.control.failed()
        assertEquals(PrivateDnsControl.AUTOMATIC,r.os);assertEquals(prior,r.saved.baseline)
        r.control.apply(on());assertEquals(PrivateDnsControl.AUTOMATIC,r.os)
        r.control.disable();assertEquals(prior,r.os)
    }
    @Test fun explicitRetryPreservesTheOriginalUndoRecord(){
        val prior=DnsSettings("off",null);val r=Rig(prior);r.control.approve();r.control.apply(on());r.control.failed();r.control.retry();r.control.apply(on())
        assertEquals("hostname",r.os.mode);r.control.disable();assertEquals(prior,r.os)
    }
    @Test fun disabledFallbackDoesNotChangeAndroidOnProbeFailure(){
        val r=Rig();r.control.approve();r.control.apply(on(fallback=false));val before=r.os;r.control.failed();assertEquals(before,r.os)
    }
    @Test fun aManualProviderChangeIsPreservedAndCancelsAutomaticControl(){
        val r=Rig();r.control.approve();r.control.apply(on());r.os=DnsSettings("hostname","user.example.net");r.control.apply(on(2));r.control.disable(true)
        assertEquals("user.example.net",r.os.hostname);assertFalse(r.saved.consent)
    }
    @Test fun noPermissionNoLocalApprovalOrNoTlsEndpointCannotEnableDns(){
        val r=Rig();r.control.apply(on());assertNull(r.os.mode);assertEquals("disabled",r.saved.status)
        r.grant=false;assertThrows(IllegalStateException::class.java){r.control.approve()};r.grant=true;r.control.approve();r.grant=false;r.control.apply(on(2));assertEquals("permission_required",r.saved.status);assertNull(r.os.mode)
        r.grant=true;r.control.apply(on(3).copy(configured=false));assertNull(r.os.mode)
    }
    @Test fun diskFailureBeforeMutationLeavesAndroidUnchanged(){
        val r=Rig();r.control.approve();r.failSave=true;assertThrows(IllegalStateException::class.java){r.control.apply(on())};assertNull(r.os.mode)
    }
    @Test fun failedRemovalKeepsUndoAndDoesNotClaimSuccess(){
        val prior=DnsSettings(null,null);val r=Rig(prior);r.control.approve();r.control.apply(on());r.failWrite=true
        assertThrows(IllegalStateException::class.java){r.control.disable(true)};assertEquals(prior,r.saved.baseline);assertTrue(r.saved.owned);assertNotEquals("removed",r.saved.status)
        r.failWrite=false;r.control.disable(true);assertEquals(prior,r.os)
    }
    @Test fun processRestartRestoresNormalDnsAndRequiresRetry(){
        val r=Rig();r.control.approve();r.control.apply(on());r.control.interrupted();assertEquals(PrivateDnsControl.AUTOMATIC,r.os);r.control.apply(on());assertEquals(PrivateDnsControl.AUTOMATIC,r.os)
    }
    @Test fun anInterruptedOsWriteCanStillBeRestoredOffline(){
        val r=Rig(DnsSettings("off",null));r.control.approve();r.control.apply(on());r.saved=r.saved.copy(status="error");r.os=PrivateDnsControl.AUTOMATIC
        r.control.disable(true);assertEquals(DnsSettings("off",null),r.os)
    }
    @Test fun staleServerRepliesCannotReverseLocalOffOrRemoval(){
        val r=Rig();r.control.approve();r.control.apply(on());r.control.disable(true)
        r.control.apply(on());assertEquals("removed",r.saved.status);assertFalse(r.saved.consent);assertNull(r.os.mode)
        r.control.apply(on(2).copy(enabled=false));assertEquals("removed",r.saved.status)
    }
    @Test fun privateDnsRequiresAHostname(){
        for(host in listOf("10.10.20.3","https://dns.example.org","dns.example.org:853","-bad.example.org","localhost","","abc..example"))assertFalse(host,PrivateDnsControl.validHost(host))
        assertTrue(PrivateDnsControl.validHost("abc.dns.example.org"))
    }
}
