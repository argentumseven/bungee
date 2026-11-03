package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DnsPathStatusTest {
    @Test fun aReportedResolverIsNotPresentedAsCapturedBrowserTraffic() {
        val report=JSONObject().put("available",true).put("servers",JSONArray().put("10.10.20.3"))
            .put("private_dns_active",false).put("private_dns_name",JSONObject.NULL)
        val text=DnsPathStatus.describe(report)
        assertTrue(text.contains("10.10.20.3"));assertTrue(text.contains("Private DNS: not active"))
        assertTrue(text.contains("does not capture other apps’ DNS"));assertFalse(text.contains("null"))
    }
    @Test fun privateDnsIsIdentifiedWithoutCallingItBungeeRouting() {
        val report=JSONObject().put("available",true).put("servers",JSONArray()).put("private_dns_active",true).put("private_dns_name","dns.example.test")
        assertTrue(DnsPathStatus.describe(report).contains("dns.example.test"))
        assertTrue(DnsPathStatus.describe(JSONObject()).contains("unavailable"))
    }
}
