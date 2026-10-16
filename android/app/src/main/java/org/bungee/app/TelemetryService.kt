package org.bungee.app

import android.Manifest
import android.app.*
import android.app.admin.DevicePolicyManager
import android.content.*
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

data class SharingStatus(val running: Boolean = false, val connected: Boolean = false, val text: String = "Sharing is paused", val lastSent: Long? = null)

class TelemetryService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var identity: Identity
    private var worker: Job? = null
    private var tone: ToneGenerator? = null
    private var ringJob: Job? = null
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate()
        if (LocalSafety.isStopped(this) || ManagementAgent.isOwner(this)) { stopSelf(); return }
        identity = Identity(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("sharing", "Private household connection", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel("recovery", "Phone recovery messages", NotificationManager.IMPORTANCE_HIGH).apply { lockscreenVisibility = Notification.VISIBILITY_PUBLIC })
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (LocalSafety.isStopped(this) || ManagementAgent.isOwner(this)) { stopSelf(); return START_NOT_STICKY }
        if (intent == null && !LocalSafety.isRestartAllowed(this)) { stopSelf(); return START_NOT_STICKY }
        if (intent?.action == "STOP") {
            runCatching { LocalSafety.setStopped(this, true) }.onFailure { android.widget.Toast.makeText(this, "Stop could not be saved. Force-stop Bungee in Android Settings.", android.widget.Toast.LENGTH_LONG).show() }; stopSelf(); return START_NOT_STICKY
        }
        if (intent?.action == "STOP_RING") { stopRinging(); return START_NOT_STICKY }
        if (!identity.enrolled) { stopSelf(); return START_NOT_STICKY }
        val locationType = hasLocation(this) && identity.allowLocate && (intent?.action != "AUTO_START" || ManagementAgent.isOwner(this))
        val fallbackType = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE
        try { startForeground(1, notification(), if (locationType) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else fallbackType) }
        catch (_: SecurityException) { startForeground(1, notification(), fallbackType) }
        if (worker?.isActive == true) return if (LocalSafety.isRestartAllowed(this)) START_STICKY else START_NOT_STICKY
        worker = scope.launch {
            val api = HomeApi(identity)
            var nextTelemetry = 0L
            var nextSample = 0L
            var latest: Location? = null
            while (isActive) {
                if (LocalSafety.isStopped(this@TelemetryService)) { stopSelf(); break }
                try {
                    // Collect before trying the network; an outage must not stop the local trail.
                    if (System.currentTimeMillis() >= nextSample) {
                        val cached = lastLocation()
                        latest = if (identity.allowLocate && (cached == null || System.currentTimeMillis() - cached.time > 45000)) freshLocation() ?: cached else cached
                        latest?.let { point -> withContext(Dispatchers.IO) { identity.queueLocation(locationJson(point)) } }
                        nextSample = System.currentTimeMillis() + 60000
                    }
                    withContext(Dispatchers.IO) { HomeTunnel.connect(this@TelemetryService, identity, JSONObject(identity.bundle!!)) }
                    withContext(Dispatchers.IO) {
                        val desired = api.request("/v1/sync", JSONObject().put("report", ManagementAgent.report(this@TelemetryService, identity)))
                        ManagementAgent.apply(this@TelemetryService, identity, desired.getLong("revision"), desired.getJSONObject("policy"))
                        HomeTunnel.connect(this@TelemetryService, identity, JSONObject(identity.bundle!!))
                        api.request("/v1/sync", JSONObject().put("report", ManagementAgent.report(this@TelemetryService, identity)))
                    }
                    if (System.currentTimeMillis() >= nextTelemetry) {
                        upload(api, latest)
                        nextTelemetry = System.currentTimeMillis() + if (identity.state("management").optBoolean("lost_mode_active")) 30000 else 60000
                    }
                    val batch = withContext(Dispatchers.IO) { api.request("/v1/commands").getJSONArray("commands") }
                    for (n in 0 until batch.length()) execute(api, batch.getJSONObject(n))
                    status.value = status.value.copy(running = true, connected = true, text = "Connected to your household")
                } catch (e: CancellationException) { throw e }
                catch (_: Exception) {
                    // Never send diagnostics, keys, location, or enrollment tokens to a third-party logger.
                    status.value = status.value.copy(running = true, connected = false, text = "Home server unreachable · unsent fixes stay local")
                }
                delay(15000)
            }
        }
        return if (LocalSafety.isRestartAllowed(this)) START_STICKY else START_NOT_STICKY
    }
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val pause = PendingIntent.getService(this, 1, Intent(this, TelemetryService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE)
        val hush = PendingIntent.getService(this, 2, Intent(this, TelemetryService::class.java).setAction("STOP_RING"), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, "sharing").setSmallIcon(R.drawable.ic_bungee).setContentTitle("Bungee sharing is active")
            .setContentText("GPS fixes queue locally until home is reachable")
            .setContentIntent(open).setOngoing(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(0, "Pause sharing", pause).addAction(0, "Stop sound", hush).build()
    }
    private fun lastLocation(): Location? {
        if (!identity.allowLocate || !hasLocation(this)) return null
        val manager = getSystemService(LocationManager::class.java)
        // An old, timestamped fix can still be valuable after a long outage; never age it out here.
        return try { manager.getLastKnownLocation(LocationManager.GPS_PROVIDER)?.takeIf { it.time > 0 && it.time <= System.currentTimeMillis() + 120000 } } catch (_: SecurityException) { null }
    }
    private suspend fun freshLocation(): Location? {
        if (!identity.allowLocate || !hasLocation(this)) return null
        val manager = getSystemService(LocationManager::class.java)
        if (!manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) return null
        return withTimeoutOrNull(25000) {
            suspendCancellableCoroutine { continuation ->
                val cancel = CancellationSignal()
                continuation.invokeOnCancellation { cancel.cancel() }
                try { manager.getCurrentLocation(LocationManager.GPS_PROVIDER, cancel, mainExecutor) { loc -> if (continuation.isActive) continuation.resume(loc) } }
                catch (_: SecurityException) { if (continuation.isActive) continuation.resume(null) }
                catch (_: Exception) { if (continuation.isActive) continuation.resume(null) }
            }
        }
    }
    private fun locationJson(location: Location): JSONObject = JSONObject().put("latitude", location.latitude).put("longitude", location.longitude).put("accuracy", location.accuracy.toDouble()).put("observed_at", location.time / 1000)
    private suspend fun upload(api: HomeApi, location: Location?) {
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) ?: 0
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val charging = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        val point = location?.let(::locationJson)
        point?.let { withContext(Dispatchers.IO) { identity.queueLocation(it) } }
        val data = JSONObject().put("battery", (level * 100 / scale.coerceAtLeast(1)).coerceIn(0, 100)).put("charging", charging)
            .put("location", if (identity.allowLocate) point ?: JSONObject.NULL else JSONObject.NULL)
            .put("capabilities", JSONArray(capabilities(this, identity))).put("device_owner", getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(packageName))
        // Bounded batches; acknowledge only after the server commits. Retries deduplicate by observation time.
        for (batch in 0 until 8) {
            val pending = withContext(Dispatchers.IO) { identity.pendingLocations() }
            data.put("locations", pending)
            withContext(Dispatchers.IO) { api.request("/v1/telemetry", data) }
            withContext(Dispatchers.IO) { identity.acknowledgeLocations(pending) }
            if (pending.length() < 100) break
        }
        status.value = status.value.copy(lastSent = System.currentTimeMillis())
    }
    private suspend fun execute(api: HomeApi, command: JSONObject) {
        if (LocalSafety.isStopped(this) || ManagementAgent.isOwner(this)) return
        val id = command.getString("id")
        val old = identity.result(id)
        if (old != null) { withContext(Dispatchers.IO) { api.request("/v1/ack", old) }; return }
        if (command.getLong("expires") <= System.currentTimeMillis()/1000) return
        val kind = command.getString("kind")
        // Persist before acting: a crash cannot cause a lock or alarm to execute twice.
        val receipt = JSONObject().put("id", id).put("status", "failed").put("result", "Interrupted before completion; not repeated")
        identity.saveResult(id, receipt)
        try {
            if (!capabilities(this, identity).contains(kind)) {
                receipt.put("status", "rejected").put("result", "Permission or local consent was revoked")
            } else {
                val result = when (kind) {
                    "locate" -> { val fix = freshLocation() ?: error("No location fix available"); upload(api, fix); "Fresh location uploaded" }
                    "ring" -> { LocalSafety.ifAllowed(this) { startRinging() }; "Sound started for up to 30 seconds" }
                    "stop_ringing" -> { stopRinging(); "Sound stopped" }
                    "message" -> {
                        val text = command.getJSONObject("payload").getString("message").take(240)
                        identity.recoveryMessage = text
                        val open = PendingIntent.getActivity(this, 3, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
                        LocalSafety.ifAllowed(this) { getSystemService(NotificationManager::class.java).notify(2, NotificationCompat.Builder(this, "recovery")
                            .setSmallIcon(R.drawable.ic_bungee).setContentTitle("A message from your household").setContentText(text)
                            .setStyle(NotificationCompat.BigTextStyle().bigText(text)).setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setContentIntent(open).setOngoing(true).build()) }
                        "Recovery notification posted"
                    }
                    "clear_message" -> { identity.recoveryMessage = null; getSystemService(NotificationManager::class.java).cancel(2); "Message cleared" }
                    "lock" -> { LocalSafety.ifAllowed(this) { getSystemService(DevicePolicyManager::class.java).lockNow() }; "Device lock requested" }
                    else -> error("Unknown command")
                }
                receipt.put("status", "executed").put("result", result)
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            receipt.put("status", "failed").put("result", "Device could not complete this command")
        }
        identity.saveResult(id, receipt)
        withContext(Dispatchers.IO) { api.request("/v1/ack", receipt) }
    }
    private fun startRinging() {
        stopRinging()
        tone = ToneGenerator(AudioManager.STREAM_ALARM, 100)
        ringJob = scope.launch {
            repeat(30) { tone?.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 700); delay(1000) }
            stopRinging()
        }
    }
    private fun stopRinging() { ringJob?.cancel(); ringJob = null; tone?.release(); tone = null }
    override fun onDestroy() {
        stopRinging(); scope.cancel()
        Thread { runCatching { HomeTunnel.disconnect() } }.start()
        status.value = SharingStatus(); super.onDestroy()
    }
    companion object {
        val status = MutableStateFlow(SharingStatus())
        fun hasLocation(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        fun capabilities(context: Context, identity: Identity): List<String> = buildList {
            if (LocalSafety.isStopped(context) || ManagementAgent.isOwner(context)) return@buildList
            if (identity.allowLocate && hasLocation(context)) add("locate")
            if (identity.allowCommands) {
                addAll(listOf("ring", "stop_ringing"))
                if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) addAll(listOf("message", "clear_message"))
                if (context.getSystemService(DevicePolicyManager::class.java).isAdminActive(ComponentName(context, BungeeAdminReceiver::class.java))) add("lock")
            }
        }
    }
}
