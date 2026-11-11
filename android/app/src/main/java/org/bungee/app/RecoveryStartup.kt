package org.bungee.app

import android.app.Application
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BungeeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        SharingHistory.recover(this)
        // No device-owner or always-on activation. Local recovery initializes no pairing keys.
        RecoveryStartup.clearStartupReminders(this)
        runCatching { LegacyDnsRecovery.restore(this) }
        ArmedCameraService.refreshReadiness(this)
    }
}
object RecoveryStartup {
    fun clearStartupReminders(context: Context) {
        runCatching { context.getSystemService(NotificationManager::class.java).apply { cancel(4);cancel(12) } }
    }
    fun reportResumeNeeded(context: Context) {
        clearStartupReminders(context)
        SharingHistory.record(context, SharingReason.START_RESTRICTED)
        TelemetryService.status.value=TelemetryService.status.value.copy(running=false,connected=false,text="Open Bungee to resume sharing; Android restricted automatic restart")
    }
    fun startIfApproved(context: Context) {
        runCatching {
            if (LocalSafety.isStopped(context) || ManagementAgent.blocksPersonalOperation(context)) return
            if (!LocalSafety.isConnectionRestartAllowed(context)) return
            val identity = Identity(context)
            if (identity.enrolled) {
                ContextCompat.startForegroundService(context, Intent(context, TelemetryService::class.java).setAction("AUTO_START"))
            }
        }.onFailure { reportResumeNeeded(context) }
        // Credential-encrypted keys are intentionally unavailable before first unlock.
    }
}
class RecoveryBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            RecoveryStartup.clearStartupReminders(context)
            CameraBootRecovery.request(context)
            RecoveryStartup.startIfApproved(context)
            // Camera starts only from the real resumed startup activity, never this receiver.
        }
    }
}
