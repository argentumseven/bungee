package org.bungee.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import androidx.core.app.NotificationCompat
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BungeeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // No device-owner or always-on activation. Local recovery initializes no pairing keys.
        ArmedCameraService.refreshReadiness(this)
    }
}
object RecoveryStartup {
    fun showResumeNotification(context: Context) {
        runCatching {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel("resume", "Sharing needs your attention", NotificationManager.IMPORTANCE_DEFAULT))
            val open = PendingIntent.getActivity(context, 4, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            nm.notify(4, NotificationCompat.Builder(context, "resume").setSmallIcon(R.drawable.ic_bungee).setContentTitle("Open Bungee to resume sharing")
                .setContentText("Android restricted automatic restart. Open the app and start sharing.").setContentIntent(open).setAutoCancel(true).build())
        }
    }
    fun startIfApproved(context: Context) {
        runCatching {
            if (!LocalSafety.isConnectionRestartAllowed(context) || ManagementAgent.isOwner(context)) return
            val identity = Identity(context)
            if (identity.enrolled) {
                ContextCompat.startForegroundService(context, Intent(context, TelemetryService::class.java).setAction("AUTO_START"))
            }
        }.onFailure { showResumeNotification(context) }
        // Credential-encrypted keys are intentionally unavailable before first unlock.
    }
}
class RecoveryBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            RecoveryStartup.startIfApproved(context)
            // A standing camera choice does not grant permission to start a camera FGS at boot.
            ArmedCameraService.showAttention(context)
        }
    }
}
