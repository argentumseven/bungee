package org.bungee.app

import android.Manifest
import android.app.*
import android.app.admin.DevicePolicyManager
import android.content.*
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.withResumed
import kotlinx.coroutines.flow.first
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.*
import org.json.JSONObject

class MainActivity : FragmentActivity() {
    private lateinit var identity: Identity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var appearance by mutableStateOf(AppearanceMode.SYSTEM)
    private var locked by mutableStateOf(false)
    private var error by mutableStateOf<String?>(null)
    private var busy by mutableStateOf(false)
    private var enrolled by mutableStateOf(false)
    private var locallyStopped by mutableStateOf(false)
    private var pendingBundle: String? = null
    private val pairingOwner = Any()
    private var pairingText by mutableStateOf("")
    private var showPairing by mutableStateOf(false)
    private var backgroundLocation by mutableStateOf(false)
    private var showBackgroundGuide by mutableStateOf(false)
    private var backgroundGuideForRestart by mutableStateOf(false)
    private var showCommandConsent by mutableStateOf(false)
    private var showCameraConsent by mutableStateOf(false)
    private var showCameraBootConsent by mutableStateOf(false)
    private var cameraBootAllowed by mutableStateOf(false)
    private var startupAccess by mutableStateOf(false)
    private var cameraGranted by mutableStateOf(false)
    private var cameraEnabled by mutableStateOf(false)
    private var cameraResumeJob: Job? = null
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        cameraGranted = granted
        if (!granted) error = "Camera permission was not granted. Ordinary sharing still works."
    }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        runCatching { ContextCompat.startForegroundService(this, Intent(this, TelemetryService::class.java).setAction("USER_START")) }
            .onFailure { error = "Android did not allow sharing to start. Keep Bungee open and try again." }
        if (!TelemetryService.hasLocation(this)) error = "GPS permission was not granted. The connection and approved recovery controls can still work."
    }
    private val scan = registerForActivityResult(ScanContract()) { result -> result.contents?.let { pairingText = it; showPairing = true } }
    override fun onCreate(savedInstanceState: Bundle?) {
        AppearancePreference.applyTo(this)
        appearance = AppearancePreference.read(this)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (ManagementAgent.blocksPersonalOperation(this)) {
            openRecovery(); return
        }
        try { identity = Identity(this); identity.recoveryMessage } catch (_: Exception) {
            openRecovery("Bungee pairing keys could not be opened. Reset pairing with new phone keys to start again."); return
        }
        enrolled = identity.enrolled; locked = identity.appLock
        setContent { BungeeTheme(appearance, window) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { if (locked) LockScreen() else HomeScreen() }
        } }
    }
    override fun onStop() { super.onStop(); if (::identity.isInitialized && identity.appLock) locked = true }
    override fun onResume() { super.onResume(); backgroundLocation = TelemetryService.hasBackgroundLocation(this); locallyStopped = LocalSafety.isStopped(this); cameraGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED; cameraBootAllowed = LocalSafety.isCameraRestartAllowed(this); startupAccess = CameraBootRecovery.hasStartupAccess(this) }
    override fun onPostResume() {
        super.onPostResume()
        cameraEnabled = LocalSafety.isCameraEnabled(this)
        resumeCameraIfEnabled()
    }
    private fun openRecovery(message: String = "") {
        PairingRecoveryPanel(this) { recreate() }.show(message)
    }
    private fun openStartupAccess() {
        runCatching { startActivity(Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:$packageName"))) }
            .onFailure { error = "Open Android Settings → Apps → Special app access → Display over other apps → Bungee." }
    }
    private fun resumeCameraIfEnabled() {
        if (!::identity.isInitialized || !LocalSafety.isCameraEnabled(this) || LocalSafety.isStopped(this) || ManagementAgent.blocksPersonalOperation(this)) return
        if (!identity.enrolled || !identity.allowCommands || getSystemService(KeyguardManager::class.java).isDeviceLocked) return
        if (cameraResumeJob?.isActive == true) return
        cameraResumeJob = scope.launch {
            try {
                if (!TelemetryService.status.value.running) {
                    ContextCompat.startForegroundService(this@MainActivity, Intent(this@MainActivity, TelemetryService::class.java).setAction("USER_START"))
                    withTimeout(5000) { TelemetryService.status.first { it.running } }
                }
                if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) ArmedCameraService.resume(this@MainActivity)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                ArmedCameraService.refreshReadiness(this@MainActivity, e.message ?: "Check Android permissions")
            }
        }
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    private fun unlock(requireCredential: Boolean = false, onSuccess: () -> Unit = { locked = false }) {
        if (!getSystemService(KeyguardManager::class.java).isDeviceSecure) { error = "Set a screen lock in Android settings first."; return }
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                // Device-credential authentication can return before this activity resumes.
                // Camera foreground starts must wait for actual visible/resumed authority.
                scope.launch { lifecycle.withResumed { onSuccess() } }
            }
            override fun onAuthenticationError(code: Int, text: CharSequence) { error = text.toString() }
        }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Unlock Bungee").setSubtitle("Use your phone’s screen lock")
            .setAllowedAuthenticators(if (requireCredential) DEVICE_CREDENTIAL else BIOMETRIC_STRONG or DEVICE_CREDENTIAL).build())
    }
    private fun pair(text: String) {
        try {
            check(!LocalSafety.isStopped(this) && !ManagementAgent.blocksPersonalOperation(this)) { "Open Pairing & recovery before pairing" }
            require(text.length <= 8192) { "Invitation is too large" }
            val bundle = JSONObject(text)
            require(bundle.getLong("expires") > 0) { "Invalid invitation expiry" }
            // The server enforces first-use expiry; an already-bound key may confirm a lost reply.
            require(bundle.getJSONObject("wireguard").getString("client_public_key") == identity.wgPublic) { "Invitation belongs to another phone" }
            pendingBundle = text
            finishPairing()
        } catch (e: Exception) { error = e.message ?: "Invalid enrollment" }
    }
    private fun finishPairing() {
        val text = pendingBundle ?: return
        busy = true; error = null
        scope.launch {
            try {
                identity.bundle = text
                withContext(Dispatchers.IO) {
                    HomeTunnel.connect(this@MainActivity, identity, JSONObject(text), pairingOwner)
                    // The gateway may be refreshing peers for a few seconds; retries are safe until enrollment succeeds.
                    var success = false
                    for (attempt in 1..3) {
                        try { HomeApi(identity).enroll(TelemetryService.capabilities(this@MainActivity, identity)); success = true; break }
                        catch (e: Exception) { if (attempt == 3) throw e; delay(3000) }
                    }
                    check(success)
                }
                enrolled = true; showPairing = false; pairingText = ""; pendingBundle = null
                startSharing()
            } catch (e: Exception) { error = "Pairing failed: ${e.message}. Check the gateway address and UDP port." }
            finally {
                withContext(NonCancellable + Dispatchers.IO) { runCatching { HomeTunnel.disconnectOwned(pairingOwner) } }
                busy = false
            }
        }
    }
    private fun startSharing() {
        if (LocalSafety.isStopped(this) || ManagementAgent.blocksPersonalOperation(this)) { error = "Open Pairing & recovery before restarting. Resolve any Android device/profile ownership there first."; return }
        val needed = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        permissions.launch(needed.toTypedArray())
    }
    @Composable private fun LockScreen() {
        Column(Modifier.fillMaxSize().padding(38.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Outlined.Fingerprint, null, Modifier.size(65.dp), tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(26.dp)); Text("Bungee is locked", fontSize = 29.sp, fontWeight = FontWeight.SemiBold)
            Text("Unlock to view this phone’s Bungee settings.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(vertical = 13.dp))
            Button(onClick = { unlock() }, modifier = Modifier.fillMaxWidth().padding(top = 20.dp), shape = RoundedCornerShape(13.dp)) { Text("Unlock Bungee", Modifier.padding(7.dp)) }
            TextButton(onClick = { openRecovery() }) { Text("Pairing & recovery · works offline") }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, modifier = Modifier.padding(top = 15.dp)) }
        }
    }
    @Composable private fun HomeScreen() {
        val status by TelemetryService.status.collectAsState()
        val camera by ArmedCameraService.status.collectAsState()
        LaunchedEffect(camera) { cameraEnabled = LocalSafety.isCameraEnabled(this@MainActivity); cameraBootAllowed = LocalSafety.isCameraRestartAllowed(this@MainActivity) }
        var lockEnabled by remember { mutableStateOf(identity.appLock) }
        var locate by remember { mutableStateOf(identity.allowLocate) }
        var commands by remember { mutableStateOf(identity.allowCommands) }
        var recovery by remember { mutableStateOf(identity.recoveryMessage) }
        var resume by remember { mutableStateOf(LocalSafety.isRestartAllowed(this)) }
        fun saveRestart(enabled: Boolean) { runCatching { LocalSafety.setRestartAllowed(this@MainActivity, enabled) }.onSuccess { resume = enabled }.onFailure { error = "Restart preference could not be saved." } }
        Column(Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 25.dp)) {
            Row(Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 35.dp), verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.bungee_mark), contentDescription = null, modifier = Modifier.size(50.dp))
                Text(" bungee.", fontSize = 27.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f)); Icon(Icons.Outlined.Shield, "Self hosted", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
            }
            Text("SELF-HOSTED DEVICE FINDER", letterSpacing = 2.sp, fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold)
            Text(if (enrolled) "This phone" else "Pair with your\nhome server", fontSize = 30.sp, lineHeight = 37.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
            Text(if (enrolled) "Location sharing and recovery settings for this phone." else "Connect to a Bungee server to share location\nand receive recovery commands.", fontSize = 12.sp, lineHeight = 21.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 13.dp, bottom = 26.dp))
            if (!enrolled) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(22.dp)) {
                        Icon(Icons.Outlined.Key, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(27.dp))
                        Text("Phone public key", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
                        Text("Copy this public key into “Add a device” on your home server. Your private keys stay on this phone.", fontSize = 12.sp, lineHeight = 20.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 9.dp, bottom = 17.dp))
                        Text(identity.wgPublic, fontSize = 11.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(10.dp)).clickable {
                            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Bungee WireGuard public key", identity.wgPublic))
                            android.widget.Toast.makeText(this@MainActivity, "Public key copied", android.widget.Toast.LENGTH_SHORT).show()
                        }.padding(13.dp))
                        Button(onClick = { scan.launch(ScanOptions().setPrompt("Scan your Bungee enrollment invitation").setBeepEnabled(false).setOrientationLocked(false)) }, modifier = Modifier.fillMaxWidth().padding(top = 18.dp), shape = RoundedCornerShape(11.dp), enabled = !busy) {
                            Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp)); Text("  Scan invitation", Modifier.padding(6.dp))
                        }
                        TextButton(onClick = { showPairing = true }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Paste enrollment text instead", fontSize = 11.sp) }
                        if (runCatching { identity.bundle != null }.getOrDefault(false)) TextButton(onClick = { pendingBundle = identity.bundle; finishPairing() }, enabled = !busy, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Retry saved pairing", fontSize = 11.sp) }
                    }
                }
            } else {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(22.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(45.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(13.dp)), contentAlignment = Alignment.Center) { Icon(if (status.connected) Icons.Outlined.Wifi else Icons.Outlined.Pause, null, tint = MaterialTheme.colorScheme.secondary) }
                            Column(Modifier.padding(start = 13.dp)) { Text(if (status.connected) "Connected to server" else if (status.running) "Connecting to server…" else "Sharing stopped", fontSize = 14.sp, fontWeight = FontWeight.SemiBold); Text(status.text, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 5.dp)) }
                        }
                        HorizontalDivider(Modifier.padding(vertical = 20.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        Row { Icon(Icons.Outlined.VpnLock, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(17.dp)); Text("  Bungee traffic uses WireGuard to your server.", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        Text("Bungee’s app-contained connection leaves Android’s VPN slot free for your other VPN. That VPN may still filter Bungee’s UDP connection.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 10.dp))
                        Text("Queued GPS fixes: ${status.queuedFixes} · dropped at capacity: ${status.droppedFixes}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.padding(top = 10.dp))
                        Text(when (status.gpsAccess) {
                            "foreground" -> "GPS active while the location service continues. Allow background location for restart recovery."
                            "background" -> "Background GPS permission granted. Android power and location settings still apply."
                            "disabled" -> "GPS sharing is off."
                            "permission_denied" -> "Precise GPS permission is missing. Connection does not mean GPS is recording."
                            else -> "GPS is paused. Open this screen and resume GPS, or grant background location for automatic restart."
                        }, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 10.dp))
                        if (status.running && status.gpsAccess !in listOf("foreground", "background", "disabled")) TextButton(onClick = { startSharing() }) { Text("Resume GPS from this screen") }
                        status.nextRetryAt?.let { Text("Next retry around ${java.text.DateFormat.getTimeInstance().format(java.util.Date(it))}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp) }
                        status.lastSent?.let { Text("Last check-in · ${java.text.DateFormat.getTimeInstance().format(java.util.Date(it))}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp, modifier = Modifier.padding(top = 16.dp)) }
                        Button(onClick = {
                            if (status.running) { runCatching { LocalSafety.setStopped(this@MainActivity, true) }.onFailure { error = "Stop could not be saved. Deactivate Bungee administration, then force-stop it in Android Settings." }; locallyStopped = LocalSafety.isStopped(this@MainActivity); resume = false; cameraEnabled = false
                                runCatching { ArmedCameraService.disarm(this@MainActivity) }.onFailure { error = "Camera cleanup failed; use local recovery or Android Settings." }
                                stopService(Intent(this@MainActivity, TelemetryService::class.java)) }
                            else if (LocalSafety.isStopped(this@MainActivity)) unlock {
                                runCatching { LocalSafety.setStopped(this@MainActivity, false); locallyStopped = false; startSharing() }.onFailure { error = it.message }
                            }
                            else startSharing()
                        }, modifier = Modifier.fillMaxWidth().padding(top = 20.dp), shape = RoundedCornerShape(11.dp)) { Text(SharingControl.label(status.running, locallyStopped || LocalSafety.isStopped(this@MainActivity)), Modifier.padding(6.dp)) }
                        Text("Stop is saved across restarts. Resume sharing here when you are ready. Pairing & recovery can reset only Bungee if the connection is broken.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 10.dp))
                    }
                }
                Text("SHARING AND PERMISSIONS", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 9.sp, letterSpacing = 1.8.sp, modifier = Modifier.padding(top = 30.dp, bottom = 15.dp))
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(17.dp)) {
                    Column(Modifier.padding(horizontal = 18.dp)) {
                        SettingRow("Share GPS history", "Turning off cancels pending sends; already sent data stays at home until erased", locate) { value ->
                            scope.launch {
                                runCatching { withContext(Dispatchers.IO) { identity.allowLocate = value } }
                                    .onSuccess { locate = value }
                                    .onFailure { locate = identity.allowLocate; error = "Location preference or queue cleanup failed. Stop sharing and use local recovery or Android Settings." }
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        SettingRow("Household commands", "Off until you approve sound, messages, fresh GPS & optional locking", commands) { enabled ->
                            if (enabled) showCommandConsent = true
                            else scope.launch {
                                try {
                                    withContext(Dispatchers.IO) { identity.allowCommands = false }
                                    commands = false
                                    getSystemService(NotificationManager::class.java).cancel(2)
                                    withContext(Dispatchers.IO) { identity.recoveryMessage = null }
                                } catch (e: Exception) {
                                    if (e is CancellationException) throw e
                                    commands = identity.allowCommands
                                    error = "Command consent or message cleanup failed. Deactivate Bungee administration, then force-stop it in Android Settings before restarting."
                                }
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        SettingRow("Resume after restart", "After first unlock; theft photos also keep the connection recoverable", resume) { enabled -> unlock {
                            if (enabled && locate && !backgroundLocation) { backgroundGuideForRestart = true; showBackgroundGuide = true }
                            else saveRestart(enabled)
                        } }
                        if (locate && !backgroundLocation) TextButton(onClick = { backgroundGuideForRestart = false; showBackgroundGuide = true }) { Text("Allow GPS after restart") }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        SettingRow("Lock this app", "Use your phone’s secure screen lock", lockEnabled) { enabled ->
                            unlock {
                                runCatching { identity.appLock = enabled }
                                    .onSuccess { lockEnabled = enabled; locked = false }
                                    .onFailure { lockEnabled = identity.appLock; locked = true; error = "Could not save app lock. Bungee is still locked in this session. Check storage and try again." }
                            }
                        }
                    }
                }
                Card(Modifier.fillMaxWidth().padding(top = 18.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(Modifier.padding(18.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Outlined.PhotoCamera, null, Modifier.size(19.dp), tint = MaterialTheme.colorScheme.primary); Text("  Automatic theft photos", fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
                        Text(camera.detail, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 10.dp))
                        Text("Enable before the phone is lost. While ready, three new failed PIN/password entries trigger one front-camera attempt. Optional boot recovery restores protection after Android’s first unlock. After a force-stop, open Bungee manually. Camera privacy settings apply; biometric failures may not be reported.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 8.dp))
                        if (!cameraGranted) TextButton(onClick = { cameraPermission.launch(Manifest.permission.CAMERA) }) { Text("Grant camera permission") }
                        if (cameraEnabled) {
                            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.outlineVariant)
                            Text("Automatic recovery after reboot", fontSize = 12.sp, fontWeight = FontWeight.Medium)
                            Text(if (cameraBootAllowed && startupAccess) "Enabled · after Android’s first unlock, a brief Bungee startup screen restores protection and closes. No tap in Bungee is needed."
                                else "Enable once and grant Android’s ‘Display over other apps’ access. Bungee uses it to show its startup screen; it does not draw an overlay or cover your lock screen.", fontSize = 10.sp, lineHeight = 17.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                            if (!cameraBootAllowed) TextButton(onClick = { showCameraBootConsent = true }) { Text("Enable automatic boot recovery") }
                            else {
                                if (!startupAccess) TextButton(onClick = { openStartupAccess() }) { Text("Grant startup access in Android Settings") }
                                TextButton(onClick = {
                                    runCatching { LocalSafety.setCameraRestartAllowed(this@MainActivity, false); CameraBootRecovery.cancel(this@MainActivity) }
                                        .onSuccess { cameraBootAllowed = false }.onFailure { error = "Automatic recovery preference could not be saved. Use local recovery or Android Settings." }
                                }) { Text("Turn off automatic boot recovery") }
                            }
                        }
                        if (camera.armed || cameraEnabled) {
                            if (camera.armed) Text("Encrypted pending photos: ${camera.pending}/3 · discarded at capacity: ${camera.dropped}", fontSize = 10.sp, modifier = Modifier.padding(top = 10.dp))
                            else Text("Retained photos will be counted here when protection resumes.", fontSize = 10.sp, modifier = Modifier.padding(top = 10.dp))
                            Button(onClick = { scope.launch { runCatching { withContext(Dispatchers.IO) { ArmedCameraService.disarm(this@MainActivity) }; cameraEnabled = LocalSafety.isCameraEnabled(this@MainActivity) }.onFailure { error = "Camera disarmed; pending-photo cleanup failed. Use Bungee recovery or Android security settings to finish cleanup." } } }, modifier = Modifier.padding(top = 12.dp)) { Text("Disarm camera") }
                            TextButton(enabled = camera.armed, onClick = { unlock { locked = false; runCatching { ArmedCameraService.test(this@MainActivity) }.onFailure { error = it.message } } }) { Text("Take a labelled test photo") }
                            if (!camera.armed) TextButton(onClick = { resumeCameraIfEnabled() }) { Text("Resume protection") }
                            Text("Test photos go to your server and share the five-minute/six-per-hour limit.", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else {
                            Button(onClick = { showCameraConsent = true }, enabled = commands && status.running && cameraGranted, modifier = Modifier.padding(top = 12.dp)) { Text("Enable theft photos") }
                            Text("Needs sharing, household commands, camera, notifications and removable device administration. Disarming clears unsent photos; saved server photos need separate erasure.", fontSize = 9.sp, lineHeight = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                        }
                    }
                }
                Card(Modifier.fillMaxWidth().padding(top = 18.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(Modifier.padding(18.dp)) {
                        Text("Pairing & recovery", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        Text("Stop without unpairing, or reset only Bungee and create a fresh invitation. Android management repair is a separate action.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 19.sp)
                    }
                }
                TextButton(onClick = { unlock(requireCredential = true) { startActivity(Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, ComponentName(this@MainActivity, BungeeAdminReceiver::class.java)).putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Optional removable screen locking and eligible failed-credential callbacks for the separately armed camera. Camera protection needs separate one-time local approval. Locking needs your existing PIN/password afterward. No credential changes or wipe. Deactivate in Android Settings.")) } }, modifier = Modifier.padding(top = 9.dp)) {
                    Icon(Icons.Outlined.AdminPanelSettings, null, Modifier.size(17.dp)); Text("  Enable removable device administration", fontSize = 11.sp)
                }
                if (recovery != null) Card(Modifier.fillMaxWidth().padding(top = 15.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                    Column(Modifier.padding(18.dp)) { Text("From your household", fontWeight = FontWeight.SemiBold, fontSize = 12.sp); Text(recovery!!, fontSize = 13.sp, modifier = Modifier.padding(top = 9.dp)); TextButton(onClick = { unlock { identity.recoveryMessage = null; recovery = null; getSystemService(NotificationManager::class.java).cancel(2) } }) { Text("Dismiss after unlocking", fontSize = 10.sp) } }
                }
                TextButton(onClick = { openRecovery() }) { Text("Reset pairing", fontSize = 11.sp) }
            }
            Card(Modifier.fillMaxWidth().padding(top = 18.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(17.dp)) {
                Column(Modifier.padding(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Palette, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                        Text("  Appearance", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Text("Follow Android or choose a theme for Bungee.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.padding(top = 7.dp, bottom = 14.dp))
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        AppearanceMode.entries.forEachIndexed { index, mode ->
                            SegmentedButton(selected = appearance == mode, onClick = {
                                if (AppearancePreference.write(this@MainActivity, mode)) appearance = mode
                                else error = "Appearance could not be saved. Your previous choice is still selected."
                            }, shape = SegmentedButtonDefaults.itemShape(index, AppearanceMode.entries.size)) { Text(mode.label, fontSize = 11.sp) }
                        }
                    }
                }
            }
            TextButton(onClick = { openRecovery() }) { Text("Pairing & recovery") }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 20.dp), color = MaterialTheme.colorScheme.primary)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 18.dp)) }
            Row(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.FavoriteBorder, null, Modifier.size(13.dp), tint = MaterialTheme.colorScheme.primary); Text("  Self-hosted device finder", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("Version ${BuildConfig.VERSION_NAME} · no Google Play services required", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 9.sp, modifier = Modifier.padding(bottom = 22.dp))
        }
        if (showCommandConsent) AlertDialog(onDismissRequest = { showCommandConsent = false }, title = { Text("Allow household recovery commands?") }, text = {
            Text("The server administrator can request a fresh GPS fix, play or stop an alarm, and show or clear a recovery notification. Screen locking also needs removable Android device administration.\n\nEnabling commands can apply an existing lost-mode request. GPS sharing has separate consent. Turn commands off here, or stop Bungee through local recovery or Android Settings.")
        }, confirmButton = { TextButton(onClick = {
            showCommandConsent = false
            unlock {
                scope.launch {
                    try { withContext(Dispatchers.IO) { identity.allowCommands = true }; commands = true }
                    catch (e: Exception) {
                        if (e is CancellationException) throw e
                        commands = identity.allowCommands
                        error = "Command consent was not saved. Sharing was asked to stop; deactivate Bungee administration, then force-stop it in Android Settings before restarting."
                    }
                }
            }
        }) { Text("Approve with phone unlock") } }, dismissButton = { TextButton(onClick = { showCommandConsent = false }) { Text("Keep commands off") } })
        if (showCameraConsent) AlertDialog(onDismissRequest = { showCameraConsent = false }, title = { Text("Enable automatic theft photos?") }, text = {
            Text("While ready, Bungee attempts one front-camera photo after three new failed PIN/password entries in a row. Fingerprint and face failures may not be reported. Android can refuse camera access. Protection keeps a visible notification and uses Android camera indicators.\n\nPhotos are resized, stripped of EXIF metadata and stored in an encrypted queue of up to three. They go only to your Bungee server and remain there until erased. Attempts are limited to one per five minutes and six per hour, including test photos.\n\nThis approval lasts until you disarm and allows the home connection to recover automatically. Android may restore the service after process loss, retaining the failure count, rate limits and queued photos. Optional boot recovery needs separate approval and Android’s ‘Display over other apps’ access; otherwise open Bungee after reboot or an app update. Force-stop always needs a manual launch. Only this phone can enable protection.\n\nDisarm here or in the camera notification, use local recovery, or stop Bungee in Android Settings. Disarming clears unsent photos and automatic recovery. Server copies need separate erasure. Swiping the notification does not disarm protection.", modifier = Modifier.verticalScroll(rememberScrollState()))
        }, confirmButton = { TextButton(onClick = { showCameraConsent = false; unlock { locked = false; runCatching { ArmedCameraService.enable(this@MainActivity); cameraEnabled = LocalSafety.isCameraEnabled(this@MainActivity) }.onFailure { error = it.message ?: "Keep Bungee open and try arming again" } } }) { Text("Enable with phone unlock") } }, dismissButton = { TextButton(onClick = { showCameraConsent = false }) { Text("Keep disarmed") } })
        if (showCameraBootConsent) AlertDialog(onDismissRequest = { showCameraBootConsent = false }, title = { Text("Restore protection automatically?") }, text = {
            Text("After reboot or an app update, Bungee can restore approved theft-photo protection after Android’s first unlock. A brief startup screen opens and closes automatically.\n\nThis needs Android’s ‘Display over other apps’ special access. The permission is broad: Bungee uses it to open the startup screen. It draws no overlay, covers no lock screen and asks for no startup credentials. Revoke access at any time in Android Settings. Pairing keys and photos remain encrypted until first unlock.\n\nBungee makes one automatic attempt per boot/app version. The screen has a twelve-second close timer. Force-stop, revoked permissions and Android restrictions can prevent recovery. Disarming or a local stop cancels this choice.", modifier = Modifier.verticalScroll(rememberScrollState()))
        }, confirmButton = { TextButton(onClick = {
            showCameraBootConsent = false
            unlock {
                runCatching { LocalSafety.setCameraRestartAllowed(this@MainActivity, true); cameraBootAllowed = true }
                    .onSuccess { if (!CameraBootRecovery.hasStartupAccess(this@MainActivity)) openStartupAccess() }
                    .onFailure { error = "Automatic recovery consent could not be saved." }
            }
        }) { Text("Enable with phone unlock") } }, dismissButton = { TextButton(onClick = { showCameraBootConsent = false }) { Text("Keep manual recovery") } })
        if (showBackgroundGuide) AlertDialog(onDismissRequest = { showBackgroundGuide = false }, title = { Text("GPS after restart") }, text = {
            Text("Bungee records your GPS trail for your home server. To resume GPS after reboot and first unlock, Android requires Location → Allow all the time, with precise location enabled. This is optional and reversible in Android Settings. Without it, automatic restart can reconnect but GPS stays paused until you open Bungee and resume GPS. No data is available before the first unlock.")
        }, confirmButton = { TextButton(onClick = {
            showBackgroundGuide = false
            runCatching { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))) }
                .onFailure { error = "Open Android Settings → Apps → Bungee → Permissions → Location." }
        }) { Text("Open Android Settings") } }, dismissButton = {
            Column {
                if (backgroundGuideForRestart) TextButton(onClick = { saveRestart(true); showBackgroundGuide = false }) { Text("Resume connection only") }
                TextButton(onClick = { showBackgroundGuide = false }) { Text("Cancel") }
            }
        })
        if (showPairing) AlertDialog(onDismissRequest = { if (!busy) showPairing = false }, title = { Text("Pair with your server") }, text = {
            Column { Text("Pairing connects this phone to the selected server. When sharing is active, location and battery reports go to that server. GPS history stays there until erased or the device is revoked. Up to 10,080 unsent GPS fixes are encrypted on this phone. Recovery commands stay off until you approve them separately.", fontSize = 12.sp, lineHeight = 20.sp); OutlinedTextField(value = pairingText, onValueChange = { pairingText = it }, label = { Text("Enrollment invitation") }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp), minLines = 4); error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 11.sp) } }
        }, confirmButton = { TextButton(onClick = { pair(pairingText) }, enabled = !busy) { Text("Agree & pair") } }, dismissButton = { TextButton(onClick = { showPairing = false }, enabled = !busy) { Text("Cancel") } })

    }
    @Composable private fun SettingRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text(title, fontSize = 12.sp, fontWeight = FontWeight.Medium); Text(subtitle, fontSize = 9.sp, lineHeight = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp)) }
            Switch(checked = checked, onCheckedChange = onChange, modifier = Modifier.padding(start = 10.dp))
        }
    }
}
