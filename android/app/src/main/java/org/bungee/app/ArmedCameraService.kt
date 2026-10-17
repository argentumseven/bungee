package org.bungee.app

import android.Manifest
import android.app.*
import android.app.admin.DevicePolicyManager
import android.content.*
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.display.DisplayManager
import android.view.Display
import android.view.Surface
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import java.util.UUID

data class ArmedCameraStatus(val armed: Boolean = false, val detail: String = "Disarmed · arm locally after each restart", val pending: Int = 0, val dropped: Long = 0)

/** A locally started CAMERA foreground service, never started by a password/boot/server callback. */
class ArmedCameraService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var identity: Identity
    private val gate = FailedUnlockGate()
    @Volatile private var session: String? = null
    private var captureJob: Job? = null
    private var captureManual = false
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "DISARM") { runCatching { disarm(this) }; stopSelf(); return START_NOT_STICKY }
        if (session != null) return START_NOT_STICKY
        val token = intent?.getStringExtra("approval")
        val approved = pendingApproval
        pendingApproval = null
        if (token == null || approved?.first != token || SystemClock.elapsedRealtime() - approved.second !in 0..5000) {
            stopSelf(); return START_NOT_STICKY
        }
        try {
            prerequisites(this, requireUnlocked = true)
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel("armed_camera", "Locally armed recovery camera", NotificationManager.IMPORTANCE_LOW))
            check(nm.getNotificationChannel("armed_camera").importance != NotificationManager.IMPORTANCE_NONE) { "Enable armed-camera notifications in Android Settings" }
            val stop = PendingIntent.getService(this, 10, Intent(this, ArmedCameraService::class.java).setAction("DISARM"), PendingIntent.FLAG_IMMUTABLE)
            val open = PendingIntent.getActivity(this, 11, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            ServiceCompat.startForeground(this, 10, NotificationCompat.Builder(this, "armed_camera")
                .setSmallIcon(R.drawable.ic_bungee).setContentTitle("Bungee recovery camera is armed")
                .setContentText("One front-camera attempt after 3 failed credential entries. Tap Disarm to stop.")
                .setContentIntent(open).setDeleteIntent(stop).setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setOngoing(true)
                .addAction(NotificationCompat.Action.Builder(0, "Disarm camera", stop).setAuthenticationRequired(true).build())
                .build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
            active = this // Also prevents a second local arm while encrypted state initializes.
            scope.launch {
                try {
                    identity = withContext(Dispatchers.IO) { Identity(this@ArmedCameraService).also {
                        check(it.enrolled && it.allowCommands && it.photoEpoch != null) { "Pair with the updated server, start sharing and approve household commands first" }
                        it.beginPhotoSession(token)
                    } }
                    prerequisites(this@ArmedCameraService, requireUnlocked = false)
                    check(identity.allowCommands && !LocalSafety.isStopped(this@ArmedCameraService))
                    gate.reset(getSystemService(DevicePolicyManager::class.java).currentFailedPasswordAttempts)
                    session = token; active = this@ArmedCameraService
                    status.value = ArmedCameraStatus(true, "Armed · 3 new failed credential entries trigger one attempt")
                    while (isActive) {
                        prerequisites(this@ArmedCameraService, requireUnlocked = false)
                        check(identity.allowCommands && identity.enrolled)
                        delay(1000)
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    val cleanup = runCatching { disarm(this@ArmedCameraService) }
                    if (cleanup.isSuccess) status.value = ArmedCameraStatus(detail = "Disarmed · ${e.message ?: "Android revoked a required permission"}")
                    stopSelf()
                }
            }
        } catch (e: Exception) {
            status.value = ArmedCameraStatus(detail = "Disarmed · ${e.message ?: "Android refused the camera service"}")
            stopSelf()
        }
        return START_NOT_STICKY
    }
    private fun failed(attempts: Int, manual: Boolean = false) {
        if (session == null || captureJob?.isActive == true) return
        if (!(if (manual) gate.test(SystemClock.elapsedRealtime()) else gate.failed(attempts, SystemClock.elapsedRealtime()))) {
            if (manual) status.value = status.value.copy(detail = "Armed · capture rate limit; wait at least five minutes")
            return
        }
        val armedSession = session ?: return
        captureManual = manual
        captureJob = scope.launch {
            val stamp = PrivacySends.fence.stamp()
            val epoch = identity.photoEpoch
            val allowed = { session == armedSession && identity.enrolled && identity.allowCommands && identity.photoEpoch == epoch && !LocalSafety.isStopped(this@ArmedCameraService) && getSystemService(KeyguardManager::class.java).isDeviceLocked != manual }
            var ticket: DisclosureFence.Ticket? = null
            try {
                check(epoch != null)
                prerequisites(this@ArmedCameraService, requireUnlocked = false)
                val job = currentCoroutineContext().job
                ticket = PrivacySends.fence.reserve(stamp, allowed, { job.cancel() })
                val sensor = getSystemService(CameraManager::class.java).getCameraCharacteristics(FrontCamera.cameraId(this@ArmedCameraService))
                    .get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
                val rotation = when (getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)?.rotation) { Surface.ROTATION_90 -> 90; Surface.ROTATION_180 -> 180; Surface.ROTATION_270 -> 270; else -> 0 }
                val original = withTimeout(8000) { FrontCamera.capture(this@ArmedCameraService) }
                val jpeg = withContext(Dispatchers.Default) { FrontCamera.privateJpeg(original, (sensor + rotation) % 360) }
                val photo = JSONObject().put("id", UUID.randomUUID().toString()).put("captured_at", System.currentTimeMillis()/1000)
                    .put("failed_attempts", attempts).put("reason", if (manual) "local_test" else "failed_unlock").put("jpeg", Identity.encode(jpeg))
                withContext(Dispatchers.IO) { identity.queuePhoto(photo, armedSession, epoch, stamp, allowed) }
                status.value = status.value.copy(detail = "Armed · photo saved privately for your server")
                refreshQueue(identity, armedSession)
            } catch (e: Exception) {
                if (e is CancellationException && !currentCoroutineContext().isActive) throw e
                if (session == armedSession) status.value = status.value.copy(detail = "Armed · last photo unavailable; no retry until a new credential-failure streak")
            } finally { ticket?.let { PrivacySends.fence.release(it) } }
        }
    }
    override fun onDestroy() {
        if (active === this) {
            val failures = RecoveryCoordinator.run({}, listOf(
                "Camera cancellation incomplete" to { invalidate() },
                "Pending photo cleanup failed" to { discardPending(this) }
            ))
            if (failures.isNotEmpty()) status.value = ArmedCameraStatus(detail = "Disarmed · cleanup incomplete; use local recovery or Android Settings")
        }
        session = null; scope.cancel()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    companion object {
        val status = MutableStateFlow(ArmedCameraStatus())
        @Volatile private var active: ArmedCameraService? = null
        @Volatile private var pendingApproval: Pair<String, Long>? = null
        fun currentSession(): String? = active?.session
        fun arm(activity: FragmentActivity) {
            check(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) { "Keep Bungee visible while arming" }
            check(active == null && pendingApproval == null) { "Camera is already armed or starting" }
            prerequisites(activity, requireUnlocked = true)
            val token = UUID.randomUUID().toString()
            pendingApproval = token to SystemClock.elapsedRealtime()
            try { ContextCompat.startForegroundService(activity, Intent(activity, ArmedCameraService::class.java).putExtra("approval", token)) }
            catch (e: Exception) { pendingApproval = null; throw e }
        }
        private fun prerequisites(context: Context, requireUnlocked: Boolean) {
            check(!LocalSafety.isStopped(context) && !ManagementAgent.isOwner(context)) { "Use local recovery first" }
            check(TelemetryService.status.value.running) { "Start Bungee sharing first" }
            val kg = context.getSystemService(KeyguardManager::class.java)
            check(kg.isDeviceSecure && (!requireUnlocked || !kg.isDeviceLocked)) { "Set a secure screen lock and unlock the phone" }
            check(context.getSystemService(DevicePolicyManager::class.java).isAdminActive(ComponentName(context, BungeeAdminReceiver::class.java))) { "Enable removable device administration for credential callbacks" }
            check(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) { "Grant camera permission locally first" }
            check(NotificationManagerCompat.from(context).areNotificationsEnabled()) { "Enable Bungee notifications first" }
            val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel("armed_camera")
            check(channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE) { "Enable armed-camera notifications first" }
            FrontCamera.cameraId(context)
        }
        private fun invalidate() = PrivacySends.fence.change {
            pendingApproval = null
            active?.let { it.session = null; it.captureJob?.cancel() }
            active = null
            status.value = ArmedCameraStatus()
        }
        fun discardPending(context: Context) = synchronized(PhotoOutbox.lock) {
            check(context.getSharedPreferences("identity", Context.MODE_PRIVATE).edit().remove("state_armed_photos").commit()) { "Pending photo cleanup failed; use Android Settings to clear Bungee storage" }
        }
        fun disarm(context: Context) {
            val failures = RecoveryCoordinator.run({}, listOf(
                "Camera cancellation incomplete" to { invalidate() },
                "Camera service could not be stopped" to { context.stopService(Intent(context, ArmedCameraService::class.java)); Unit },
                "Pending photo cleanup failed" to { discardPending(context) }
            ))
            if (failures.isNotEmpty()) {
                status.value = ArmedCameraStatus(detail = "Disarmed · cleanup incomplete; use local recovery or Android Settings")
                error(failures.joinToString("; "))
            }
        }
        fun passwordFailed(attempts: Int) { active?.let { service -> service.scope.launch { service.failed(attempts) } } }
        fun test(activity: FragmentActivity) {
            check(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) && !activity.getSystemService(KeyguardManager::class.java).isDeviceLocked)
            checkNotNull(active) { "Arm the camera first" }.failed(0, manual = true)
        }
        fun passwordSucceeded() { active?.let { service -> service.scope.launch {
            // The local test's own credential prompt can deliver this callback late.
            // It must cancel an automatic locked capture, not the explicitly approved test.
            if (!service.captureManual) service.captureJob?.cancel()
            service.gate.reset()
        } } }
        fun refreshQueue(identity: Identity, session: String) {
            val report = identity.photoQueueReport(session)
            if (currentSession() == session) status.value = status.value.copy(pending = report.first, dropped = report.second)
        }
    }
}
