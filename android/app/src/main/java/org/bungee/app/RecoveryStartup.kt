package org.bungee.app

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BungeeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // No device-owner or always-on activation. Local recovery initializes no pairing keys.
    }
}
object RecoveryStartup {
    fun startIfApproved(context: Context) {
        runCatching {
            if (!LocalSafety.isRestartAllowed(context) || ManagementAgent.isOwner(context)) return
            val identity = Identity(context)
            if (identity.enrolled) {
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
