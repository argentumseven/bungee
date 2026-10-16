package org.bungee.app

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.wireguard.android.backend.GoBackend

class BungeeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        GoBackend.setAlwaysOnCallback { RecoveryStartup.startIfApproved(this) }
    }
}
object RecoveryStartup {
    fun startIfApproved(context: Context) {
        runCatching {
            val identity = Identity(context)
            val policy = identity.state("management").optJSONObject("policy")
            val managed = ManagementAgent.isOwner(context) && identity.managementConsent &&
                (identity.managedDns || policy?.optBoolean("always_on") == true)
            if (identity.enrolled && (identity.autoResume || managed)) {
                ContextCompat.startForegroundService(context, Intent(context, TelemetryService::class.java).setAction("AUTO_START"))
            }
        }
        // Credential-encrypted keys are intentionally unavailable before first unlock.
    }
}
class RecoveryBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) RecoveryStartup.startIfApproved(context)
    }
}
