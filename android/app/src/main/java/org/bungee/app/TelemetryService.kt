package org.bungee.app

import android.Manifest
import android.app.*
import android.app.admin.DevicePolicyManager
import android.content.*
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.Network
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

data class SharingStatus(val running: Boolean = false, val connected: Boolean = false, val text: String = "Sharing is paused", val lastSent: Long? = null, val queuedFixes: Int = 0, val droppedFixes: Long = 0, val nextRetryAt: Long? = null, val gpsAccess: String = "paused")

class TelemetryService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var identity: Identity
    private var worker: Job? = null
    private var tone: ToneGenerator? = null
    private var ringJob: Job? = null
    private var sampler: Job? = null
    @Volatile private var latest: Location? = null
    @Volatile private var network: Network? = null
    private var watchingNetwork = false
    private var locationForeground = false
    private fun canSample() = identity.allowLocate && hasLocation(this) && locationForeground
    private fun updateLocationStatus() {
        status.value = status.value.copy(gpsAccess = LocationAccess.describe(hasLocation(this), hasBackgroundLocation(this), identity.allowLocate, locationForeground))
    }
    private val tunnelOwner = Any()
    private val networkChanged = Channel<Unit>(Channel.CONFLATED)
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(value: Network) { network = value; networkChanged.trySend(Unit) }
        override fun onLost(value: Network) { if (network == value) { network = null; networkChanged.trySend(Unit) } }
    }
    private fun elapsed() = SystemClock.elapsedRealtime()
    private suspend fun updateQueueStatus() {
        val report = withContext(Dispatchers.IO) { identity.backlogReport() }
        status.value = status.value.copy(queuedFixes = report.getInt("queued_fixes"), droppedFixes = report.getLong("dropped_fixes"))
    }
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate()
        if (LocalSafety.isStopped(this) || ManagementAgent.isOwner(this)) { stopSelf(); return }
        identity = Identity(this)
        val cm = getSystemService(ConnectivityManager::class.java)
        network = runCatching { cm.activeNetwork }.getOrNull()
        watchingNetwork = runCatching { cm.registerDefaultNetworkCallback(callback); true }.getOrDefault(false)
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
        val locationType = LocationAccess.canStartLocation(intent?.action == "USER_START", hasLocation(this), hasBackgroundLocation(this), identity.allowLocate)
        val fallbackType = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE
        try {
            try {
                locationForeground = locationType
                startForeground(1, notification(), if (locationType) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else fallbackType)
            } catch (_: SecurityException) {
                locationForeground = false
                startForeground(1, notification(), fallbackType)
            }
        } catch (_: RuntimeException) {
            RecoveryStartup.showResumeNotification(this)
            stopSelf(); return START_NOT_STICKY
        }
        updateLocationStatus()
        if (worker?.isActive == true) return if (LocalSafety.isRestartAllowed(this)) START_STICKY else START_NOT_STICKY
        status.value = status.value.copy(running = true, connected = false, text = "Connecting to your household", nextRetryAt = null)
        // Sampling is independent: a long network timeout/backoff cannot suspend the GPS trail.
        sampler = scope.launch {
            while (isActive && !LocalSafety.isStopped(this@TelemetryService)) {
                val nextSample = elapsed() + 60_000
                try {
                    updateLocationStatus()
                    val cached = lastLocation()
                    latest = if (canSample() && (cached == null || System.currentTimeMillis() - cached.time > 45000)) freshLocation() ?: cached else cached
                    latest?.let { point -> withContext(Dispatchers.IO) { identity.queueLocation(locationJson(point)) } }
                    updateQueueStatus()
                } catch (e: CancellationException) { throw e }
                catch (_: Exception) { status.value = status.value.copy(text = "GPS queue unavailable · check local storage") }
                delay((nextSample - elapsed()).coerceAtLeast(1))
            }
        }
        worker = scope.launch {
            val api = HomeApi(identity)
            val retry = DdilRetry()
            var nextTelemetry = 0L
            while (isActive) {
                if (LocalSafety.isStopped(this@TelemetryService)) { stopSelf(); break }
                if (networkChanged.tryReceive().isSuccess) {
                    withContext(Dispatchers.IO) { HomeTunnel.disconnectOwned(tunnelOwner) }
                    retry.networkChanged(elapsed())
                }
                val noNetwork = watchingNetwork && network == null
                val wait = if (noNetwork) 60_000L else (retry.nextAttempt - elapsed()).coerceAtLeast(0)
                if (noNetwork || wait > 0) {
                    if (noNetwork) {
                        withContext(Dispatchers.IO) { HomeTunnel.disconnectOwned(tunnelOwner) }
                        status.value = status.value.copy(running = true, connected = false, text = "No network · GPS stays queued on this phone", nextRetryAt = null)
                    }
                    val event = withTimeoutOrNull(wait.coerceAtLeast(1)) { networkChanged.receive(); true } == true
                    if (event) {
                        withContext(Dispatchers.IO) { HomeTunnel.disconnectOwned(tunnelOwner) }
                        retry.networkChanged(elapsed())
                    } else if (noNetwork) {
                        val available = runCatching { getSystemService(ConnectivityManager::class.java).activeNetwork }.getOrNull()
                        if (available != null) { network = available; retry.networkChanged(elapsed()) }
                    }
                    continue
                }
                val started = elapsed()
                retry.attempted(started)
                try {
                    withContext(Dispatchers.IO) { HomeTunnel.connect(this@TelemetryService, identity, JSONObject(identity.bundle!!), tunnelOwner) }
                    // Commands and saved receipts take precedence over bulk GPS catch-up on a short link.
                    val batch = withContext(Dispatchers.IO) { api.request("/v1/commands").getJSONArray("commands") }
                    val deadline = elapsed() + 20_000
                    if (elapsed() < deadline) withContext(Dispatchers.IO) {
                        val desired = api.request("/v1/sync", JSONObject().put("report", ManagementAgent.report(this@TelemetryService, identity)))
                        ManagementAgent.apply(this@TelemetryService, identity, desired.getLong("revision"), desired.getJSONObject("policy"))
                    }
                    flushReceipts(api, deadline)
                    for (n in 0 until batch.length()) {
                        if (elapsed() >= deadline) break
                        execute(api, batch.getJSONObject(n), deadline)
                    }
                    if (elapsed() < deadline && (elapsed() >= nextTelemetry || status.value.queuedFixes > 0)) {
                        upload(api, latest, retry.batchSize)
                        nextTelemetry = elapsed() + if (identity.state("management").optBoolean("lost_mode_active")) 30_000 else 60_000
                    }
                    retry.succeeded(elapsed(), elapsed() - started)
                    updateQueueStatus()
                    status.value = status.value.copy(running = true, connected = true, text = if (status.value.queuedFixes > 0) "Connected · sending saved GPS in bounded batches" else "Connected to your household", nextRetryAt = null)
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    retry.failed(elapsed(), e is HomeApiException && e.status == 401)
                    // Close keepalives during denial/backoff. This changes only Bungee's own socket.
                    withContext(Dispatchers.IO) { HomeTunnel.disconnectOwned(tunnelOwner) }
                    status.value = status.value.copy(running = true, connected = false,
                        text = if (e is HomeApiException && e.status == 401) "Authentication rejected · check pairing and phone/server clocks" else "Home unavailable · saved data waits for retry",
                        nextRetryAt = System.currentTimeMillis() + retry.nextAttempt - elapsed())
                }
            }
        }
        return if (LocalSafety.isRestartAllowed(this)) START_STICKY else START_NOT_STICKY
    }
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val pause = PendingIntent.getService(this, 1, Intent(this, TelemetryService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE)
        val hush = PendingIntent.getService(this, 2, Intent(this, TelemetryService::class.java).setAction("STOP_RING"), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, "sharing").setSmallIcon(R.drawable.ic_bungee).setContentTitle("Bungee sharing is active")
            .setContentText(if (locationForeground) "GPS fixes queue locally until home is reachable" else "Connection active · open Bungee to resume GPS")
            .setContentIntent(open).setOngoing(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(0, "Pause sharing", pause).addAction(0, "Stop sound", hush).build()
    }
    private fun lastLocation(): Location? {
        if (!canSample()) return null
        val manager = getSystemService(LocationManager::class.java)
        // An old, timestamped fix can still be valuable after a long outage; never age it out here.
        return try { manager.getLastKnownLocation(LocationManager.GPS_PROVIDER)?.takeIf { it.time > 0 && it.time <= System.currentTimeMillis() + 120000 } } catch (_: SecurityException) { null }
    }
    private suspend fun freshLocation(): Location? {
        if (!canSample()) return null
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
    private suspend fun upload(api: HomeApi, location: Location?, limit: Int = 25) {
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, 0) ?: 0
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val charging = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        val cutoff = api.clock.gpsCutoff(elapsed())
        val point = if (!identity.allowLocate) null else location?.let(::locationJson)?.takeIf { GpsBacklog.usable(it, cutoff) }
            ?: withContext(Dispatchers.IO) { identity.newestQueuedLocation(cutoff) }
        point?.let { withContext(Dispatchers.IO) { identity.queueLocation(it) } }
        val data = JSONObject().put("battery", (level * 100 / scale.coerceAtLeast(1)).coerceIn(0, 100)).put("charging", charging)
            .put("location", if (identity.allowLocate) point ?: JSONObject.NULL else JSONObject.NULL)
            .put("capabilities", JSONArray(capabilities(this, identity))).put("device_owner", getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(packageName))
        // One bounded batch per cycle; uncertain acknowledgements preserve the encrypted queue.
        val pending = withContext(Dispatchers.IO) { identity.pendingLocations(limit, cutoff) }
        data.put("locations", pending)
        val response = withContext(Dispatchers.IO) { api.request("/v1/telemetry", data) }
        check(response.optBoolean("accepted")) { "Telemetry was not committed" }
        withContext(Dispatchers.IO) { identity.acknowledgeLocations(pending) }
        status.value = status.value.copy(lastSent = System.currentTimeMillis())
    }
    private suspend fun flushReceipts(api: HomeApi, deadline: Long) {
        val pending = withContext(Dispatchers.IO) { identity.pendingReceipts() }
        for (i in 0 until pending.length()) {
            if (elapsed() >= deadline) break
            sendReceipt(api, pending.getJSONObject(i))
        }
    }
    private suspend fun sendReceipt(api: HomeApi, receipt: JSONObject) {
        val response = withContext(Dispatchers.IO) { api.request("/v1/ack", receipt) }
        if (ReceiptOutbox.confirmed(response)) withContext(Dispatchers.IO) { identity.settleReceipt(receipt.getString("id")) }
    }
    private suspend fun execute(api: HomeApi, command: JSONObject, deadline: Long) {
        if (LocalSafety.isStopped(this) || ManagementAgent.isOwner(this)) return
        val id = command.getString("id")
        val old = identity.result(id)
        if (old != null) { sendReceipt(api, old); return }
        val attempted = api.clock.upperNow(elapsed())
        val expires = command.getLong("expires")
        if (expires <= attempted) return
        val kind = command.getString("kind")
        // Persist before acting: a crash cannot cause a lock or alarm to execute twice.
        val receipt = JSONObject().put("id", id).put("status", "failed").put("result", "Outcome unknown after interruption; not repeated").put("attempted_at", attempted)
        withContext(Dispatchers.IO) { identity.saveResult(id, receipt, expires) }
        try {
            if (api.clock.upperNow(elapsed()) >= expires || elapsed() >= deadline) {
                receipt.put("status", "rejected").put("result", "Deadline passed before execution; not repeated")
            } else if (!capabilities(this, identity).contains(kind)) {
                receipt.put("status", "rejected").put("result", "Permission or local consent was revoked")
            } else {
                val result = when (kind) {
                    "locate" -> { val available = minOf(deadline - elapsed(), (expires - api.clock.upperNow(elapsed())) * 1000).coerceAtLeast(0); val fix = withTimeoutOrNull(available) { freshLocation() } ?: error("No timely location fix available"); upload(api, fix); "Fresh location uploaded" }
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
        withContext(Dispatchers.IO) { identity.saveResult(id, receipt, expires) }
        sendReceipt(api, receipt)
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
        if (watchingNetwork) runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(callback) }
        stopRinging(); scope.cancel()
        networkChanged.close()
        Thread { runCatching { HomeTunnel.disconnectOwned(tunnelOwner) } }.start()
        status.value = SharingStatus(); super.onDestroy()
    }
    companion object {
        val status = MutableStateFlow(SharingStatus())
        fun hasLocation(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        fun hasBackgroundLocation(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
        fun capabilities(context: Context, identity: Identity): List<String> = buildList {
            if (LocalSafety.isStopped(context) || ManagementAgent.isOwner(context)) return@buildList
            if (identity.allowLocate && hasLocation(context) && status.value.gpsAccess in listOf("foreground", "background")) add("locate")
            if (identity.allowCommands) {
                addAll(listOf("ring", "stop_ringing"))
                if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) addAll(listOf("message", "clear_message"))
                if (context.getSystemService(DevicePolicyManager::class.java).isAdminActive(ComponentName(context, BungeeAdminReceiver::class.java))) add("lock")
            }
        }
    }
}
