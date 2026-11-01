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

data class ArmedCameraStatus(val armed: Boolean = false, val detail: String = "Disabled · enable theft photos once on this phone", val pending: Int = 0, val dropped: Long = 0, val failedInRow: Int = 0)

/** One local opt-in; visible starts and same-boot system restarts only. No boot/server camera starts. */
class ArmedCameraService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var identity: Identity
    private lateinit var lease: CameraLease
    private val gate get() = lease.gate
    @Volatile private var session: String? = null
    private var captureJob: Job? = null
    private var captureManual = false
    private var observedFailures: Int? = null
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "DISARM") { runCatching { disarm(this) }; stopSelf(); return START_NOT_STICKY }
        if (active === this) return if (LocalSafety.isCameraEnabled(this)) START_STICKY else START_NOT_STICKY
        val visibleStart = approvals.consume(intent?.getStringExtra("approval"), SystemClock.elapsedRealtime())
        val systemRestart = intent == null || flags and START_FLAG_RETRY != 0
        if ((!visibleStart && !systemRestart) || !LocalSafety.isCameraEnabled(this)) {
            stopSelf(); return START_NOT_STICKY
        }
        val stamp = PrivacySends.fence.stamp()
        try {
            prerequisites(this, requireUnlocked = visibleStart)
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel("armed_camera", "Recovery camera protection", NotificationManager.IMPORTANCE_LOW))
            check(nm.getNotificationChannel("armed_camera").importance != NotificationManager.IMPORTANCE_NONE) { "Enable camera-protection notifications in Android Settings" }
            ServiceCompat.startForeground(this, 10, notification(ready = false), ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
            active = this
            scope.launch {
                try {
                    identity = withContext(Dispatchers.IO) { Identity(this@ArmedCameraService) }
                    check(identity.enrolled && identity.allowCommands && identity.photoEpoch != null) { "Pair with the updated server and approve household commands first" }
                    val failures = getSystemService(DevicePolicyManager::class.java).currentFailedPasswordAttempts
                    observedFailures = failures
                    val boot = android.provider.Settings.Global.getInt(contentResolver, android.provider.Settings.Global.BOOT_COUNT)
                    withContext(Dispatchers.IO) {
                        PrivacySends.fence.checked(stamp, { active === this@ArmedCameraService && enabled() }) {
                            lease = CameraLease.obtain(identity.state("camera_lease"), boot, SystemClock.elapsedRealtime(), failures, visibleStart)
                            identity.resumePhotoSession(lease.id)
                            identity.saveState("camera_lease", lease.snapshot())
                            session = lease.id
                        }
                    }
                    prerequisites(this@ArmedCameraService, requireUnlocked = false)
                    PrivacySends.fence.checked(stamp, { session == lease.id && enabled() }) {
                        status.value = ArmedCameraStatus(true, "Ready · automatic photo after 3 new failed credential entries")
                        refreshQueue(identity, lease.id)
                        nm.cancel(12); nm.notify(10, notification(ready = true))
                    }
                    // A sticky camera restart can arrive before the sharing service's restart.
                    // Its local opt-in also authorizes restoring the connection for queued photos.
                    if (!TelemetryService.status.value.running) runCatching {
                        ContextCompat.startForegroundService(this@ArmedCameraService, Intent(this@ArmedCameraService, TelemetryService::class.java).setAction("AUTO_START"))
                    }
                    if (getSystemService(KeyguardManager::class.java).isDeviceLocked) failed(getSystemService(DevicePolicyManager::class.java).currentFailedPasswordAttempts)
                    while (isActive) {
                        prerequisites(this@ArmedCameraService, requireUnlocked = false)
                        check(enabled()) { "Theft photos or household commands were disabled" }
                        // Some OEMs delay the admin broadcast. Observe Android's
                        // own counter as well; never infer biometric failures.
                        val failuresNow = getSystemService(DevicePolicyManager::class.java).currentFailedPasswordAttempts
                        if (observedFailures != failuresNow) {
                            observedFailures = failuresNow
                            if (failuresNow > 0) identity.saveState("unlock", JSONObject().put("failed", failuresNow).put("last_failed_at", System.currentTimeMillis()/1000))
                            failed(failuresNow)
                        }
                        delay(1000)
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    if (::identity.isInitialized && (!identity.enrolled || !identity.allowCommands)) runCatching { disarm(this@ArmedCameraService) }
                    else markUnavailable(e.message ?: "Check Android permissions")
                    stopSelf()
                }
            }
        } catch (e: Exception) {
            markUnavailable(e.message ?: "Android refused the camera service")
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }
    private fun enabled() = LocalSafety.isCameraEnabled(this) && !LocalSafety.isStopped(this) && !ManagementAgent.blocksPersonalOperation(this) && identity.enrolled && identity.allowCommands
    private fun notification(ready: Boolean): Notification {
        val stop = PendingIntent.getService(this, 10, Intent(this, ArmedCameraService::class.java).setAction("DISARM"), PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 11, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, "armed_camera").setSmallIcon(R.drawable.ic_bungee)
            .setContentTitle(if (ready) "Bungee camera is armed" else "Starting Bungee camera protection")
            .setContentText("Waiting for 3 new failed PIN/password entries. Armed does not mean a photo was captured.")
            .setContentIntent(open).setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setOngoing(true)
            .addAction(NotificationCompat.Action.Builder(0, "Disarm camera", stop).setAuthenticationRequired(true).build()).build()
    }
    private fun markUnavailable(reason: String) {
        val cleanup = runCatching { invalidate(this) }
        refreshReadiness(this, if (cleanup.isSuccess) reason else "Cancellation incomplete; use local recovery or Android Settings")
        showAttention(this)
    }
    private fun saveGate() {
        val stamp = PrivacySends.fence.stamp()
        PrivacySends.fence.checked(stamp, { session == lease.id && enabled() }) { identity.saveState("camera_lease", lease.snapshot()) }
    }
    private fun failed(attempts: Int, manual: Boolean = false) {
        if (session == null || captureJob?.isActive == true) return
        val permitted = if (manual) gate.test(SystemClock.elapsedRealtime()) else gate.failed(attempts, SystemClock.elapsedRealtime())
        status.value = status.value.copy(failedInRow = gate.progress)
        try { saveGate() } catch (_: Exception) { markUnavailable("Capture checkpoint could not be saved"); stopSelf(); return }
        if (!permitted) {
            if (manual) status.value = status.value.copy(detail = "Armed · capture rate limit; wait at least 30 seconds; maximum 20 attempts/hour")
            return
        }
        val armedSession = session ?: return
        captureManual = manual
        status.value = status.value.copy(detail = if (manual) "Capturing labelled test photo…" else "Capturing after failed credential entries…")
        captureJob = scope.launch {
            val stamp = PrivacySends.fence.stamp()
            val epoch = identity.photoEpoch
            val allowed = { session == armedSession && identity.enrolled && identity.allowCommands && identity.photoEpoch == epoch && LocalSafety.isCameraEnabled(this@ArmedCameraService) && !LocalSafety.isStopped(this@ArmedCameraService) && getSystemService(KeyguardManager::class.java).isDeviceLocked != manual }
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
                status.value = status.value.copy(detail = "Photo captured · waiting in memory for upload")
                refreshQueue(identity, armedSession)
                TelemetryService.requestPhotoUpload()
            } catch (e: Exception) {
                if (e is CancellationException && !currentCoroutineContext().isActive) {
                    if (session == armedSession && enabled()) status.value = status.value.copy(detail="Capture canceled before completion · no new picture queued")
                    throw e
                }
                if (session == armedSession) status.value = status.value.copy(detail = "Capture failed (${e.javaClass.simpleName}) · no photo to upload; try a labelled test while unlocked")
            } finally { ticket?.let { PrivacySends.fence.release(it) } }
        }
    }
    override fun onDestroy() {
        if (active === this) { runCatching { invalidate(this) }; refreshReadiness(this) }
        session = null; scope.cancel()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    companion object {
        val status = MutableStateFlow(ArmedCameraStatus())
        @Volatile private var active: ArmedCameraService? = null
        private val approvals = CameraStartApproval()
        private val controlLock = Any()
        fun currentSession(): String? = active?.session
        fun enable(activity: FragmentActivity) = synchronized(controlLock) {
            check(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) { "Keep Bungee visible while enabling theft photos" }
            prerequisites(activity, requireUnlocked = true)
            check(TelemetryService.status.value.running) { "Start Bungee sharing first" }
            val identity = Identity(activity)
            check(identity.enrolled && identity.allowCommands && identity.photoEpoch != null) { "Pair with the updated server and approve household commands first" }
            check(!LocalSafety.isCameraEnabled(activity)) { "Theft photos are already enabled" }
            // Do not adopt remnants from an old, explicitly disarmed installation/session.
            discardPending(activity)
            clearLease(activity)
            CameraBootRecovery.cancel(activity)
            LocalSafety.setCameraEnabled(activity, true)
            refreshReadiness(activity)
            resume(activity)
        }
        fun resume(activity: FragmentActivity): Unit = synchronized(controlLock) {
            check(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) { "Keep Bungee visible while arming" }
            check(LocalSafety.isCameraEnabled(activity)) { "Enable theft photos locally first" }
            if (active != null) return
            prerequisites(activity, requireUnlocked = true)
            val token = approvals.issue(SystemClock.elapsedRealtime()) ?: return
            try { ContextCompat.startForegroundService(activity, Intent(activity, ArmedCameraService::class.java).putExtra("approval", token)) }
            catch (e: Exception) { approvals.cancel(); refreshReadiness(activity, e.message); throw e }
        }
        private fun prerequisites(context: Context, requireUnlocked: Boolean) {
            check(!LocalSafety.isStopped(context) && !ManagementAgent.blocksPersonalOperation(context)) { "Use local recovery first" }
            val kg = context.getSystemService(KeyguardManager::class.java)
            check(kg.isDeviceSecure && (!requireUnlocked || !kg.isDeviceLocked)) { "Set a secure screen lock and unlock the phone" }
            check(context.getSystemService(DevicePolicyManager::class.java).isAdminActive(ComponentName(context, BungeeAdminReceiver::class.java))) { "Enable removable device administration for credential callbacks" }
            check(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) { "Grant camera permission locally first" }
            check(NotificationManagerCompat.from(context).areNotificationsEnabled()) { "Enable Bungee notifications first" }
            val channel = context.getSystemService(NotificationManager::class.java).getNotificationChannel("armed_camera")
            check(channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE) { "Enable armed-camera notifications first" }
            FrontCamera.cameraId(context)
        }
        private fun invalidate(expected: ArmedCameraService? = null) = PrivacySends.fence.change {
            if (expected != null && active !== expected) return@change
            approvals.cancel()
            active?.let { it.session = null; it.captureJob?.cancel() }
            active = null
            status.value = ArmedCameraStatus()
        }
        fun refreshReadiness(context: Context, reason: String? = null) {
            if (active != null) return
            status.value = ArmedCameraStatus(detail = if (LocalSafety.isCameraEnabled(context))
                "Enabled · not ready: ${reason ?: if (LocalSafety.isCameraRestartAllowed(context)) "automatic recovery configured; check startup access" else "open Bungee or enable automatic boot recovery"}"
            else "Disabled · enable theft photos once on this phone")
        }
        fun showAttention(context: Context) {
            if (!LocalSafety.isCameraEnabled(context) || currentSession() != null) return
            runCatching {
                val nm = context.getSystemService(NotificationManager::class.java)
                nm.createNotificationChannel(NotificationChannel("camera_attention", "Camera protection needs attention", NotificationManager.IMPORTANCE_DEFAULT))
                val open = PendingIntent.getActivity(context, 12, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
                nm.notify(12, NotificationCompat.Builder(context, "camera_attention").setSmallIcon(R.drawable.ic_bungee)
                    .setContentTitle("Open Bungee to resume theft photos")
                    .setContentText("Camera protection is enabled but not ready. Open Bungee once; Android permissions still apply.")
                    .setContentIntent(open).setAutoCancel(true).build())
            }
        }
        fun discardPending(context: Context) = synchronized(PhotoOutbox.lock) {
            PendingPhotos.clear()
            check(context.getSharedPreferences("identity", Context.MODE_PRIVATE).edit().remove("state_armed_photos").commit()) { "Pending photo cleanup failed; use Bungee recovery or Android security settings" }
        }
        private fun clearLease(context: Context) {
            check(context.getSharedPreferences("identity", Context.MODE_PRIVATE).edit().remove("state_camera_lease").commit()) { "Camera checkpoint cleanup failed" }
        }
        fun disarm(context: Context) = synchronized(controlLock) {
            val failures = RecoveryCoordinator.run({}, listOf(
                "Camera opt-out could not be saved" to { LocalSafety.setCameraEnabled(context, false) },
                "Camera cancellation incomplete" to { invalidate() },
                "Camera service could not be stopped" to { context.stopService(Intent(context, ArmedCameraService::class.java)); Unit },
                "Pending photo cleanup failed" to { discardPending(context) },
                "Camera checkpoint cleanup failed" to { clearLease(context) },
                "Automatic camera startup cleanup failed" to { CameraBootRecovery.cancel(context) },
                "Camera attention notification cleanup failed" to { context.getSystemService(NotificationManager::class.java).cancel(12) }
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
        fun passwordSucceeded(context: Context, identity: Identity) {
            if (!LocalSafety.isCameraEnabled(context) || !identity.allowCommands) return
            val stamp = PrivacySends.fence.stamp()
            runCatching {
                PrivacySends.fence.checked(stamp, { LocalSafety.isCameraEnabled(context) && !LocalSafety.isStopped(context) && identity.allowCommands }) {
                    val service = active
                    if (service?.session != null) {
                        // A local test's authentication callback can arrive late.
                        if (!service.captureManual && service.captureJob?.isActive==true) {
                            service.captureJob?.cancel()
                            status.value=status.value.copy(detail="Capture canceled when the phone unlocked · try a labelled test while unlocked")
                        }
                        service.gate.reset()
                        status.value = status.value.copy(failedInRow = 0)
                        service.saveGate()
                    } else {
                        // A successful unlock can wake the receiver before Android restores
                        // the camera service. Preserve that streak reset without starting it.
                        val saved = identity.state("camera_lease")
                        val boot = android.provider.Settings.Global.getInt(context.contentResolver, android.provider.Settings.Global.BOOT_COUNT)
                        if (saved.length() != 0 && saved.getInt("boot") == boot) {
                            val lease = CameraLease.obtain(saved, boot, SystemClock.elapsedRealtime(), 0, visibleStart = false)
                            lease.gate.reset()
                            identity.saveState("camera_lease", lease.snapshot())
                        }
                    }
                }
            }.onFailure { active?.let { it.markUnavailable("Unlock checkpoint could not be saved"); it.stopSelf() } }
        }
        fun refreshQueue(identity: Identity, session: String) {
            val report = identity.photoQueueReport(session)
            if (currentSession() == session) status.value = status.value.copy(pending = report.first, dropped = report.second)
        }
    }
}
