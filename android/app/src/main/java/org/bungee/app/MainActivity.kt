package org.bungee.app

import android.Manifest
import android.app.*
import android.app.admin.DevicePolicyManager
import android.content.*
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.*
import org.json.JSONObject

private val Purple = Color(0xFF6A57D5)
private val Muted = Color(0xFF9294A4)
private val Paper = Color(0xFFFAF9FD)

class MainActivity : FragmentActivity() {
    private lateinit var identity: Identity
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var locked by mutableStateOf(false)
    private var error by mutableStateOf<String?>(null)
    private var busy by mutableStateOf(false)
    private var enrolled by mutableStateOf(false)
    private var pendingBundle: String? = null
    private var pairingText by mutableStateOf("")
    private var showPairing by mutableStateOf(false)
    private val vpn = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { if (it.resultCode == RESULT_OK) finishPairing() else error = "VPN approval is required for the private connection." }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (TelemetryService.hasLocation(this)) {
            ContextCompat.startForegroundService(this, Intent(this, TelemetryService::class.java))
        } else error = "Location permission is needed for this foreground sharing session. You remain untracked while it is paused."
    }
    private val scan = registerForActivityResult(ScanContract()) { result -> result.contents?.let { pairingText = it; showPairing = true } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        identity = Identity(this); enrolled = identity.enrolled; locked = identity.appLock
        setContent { MaterialTheme(colorScheme = lightColorScheme(primary = Purple, background = Paper, surface = Color.White, onSurface = Color(0xFF30303C))) {
            Surface(Modifier.fillMaxSize(), color = Paper) { if (locked) LockScreen() else HomeScreen() }
        } }
    }
    override fun onStop() { super.onStop(); if (identity.appLock) locked = true }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    private fun unlock(onSuccess: () -> Unit = { locked = false }) {
        if (!getSystemService(KeyguardManager::class.java).isDeviceSecure) { error = "Set a screen lock in Android settings first."; return }
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { onSuccess() }
            override fun onAuthenticationError(code: Int, text: CharSequence) { error = text.toString() }
        }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Unlock Bungee").setSubtitle("Your household stays private")
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL).build())
    }
    private fun pair(text: String) {
        try {
            require(text.length <= 8192) { "Invitation is too large" }
            val bundle = JSONObject(text)
            require(bundle.getLong("expires") > System.currentTimeMillis()/1000) { "This invitation has expired" }
            require(bundle.getJSONObject("wireguard").getString("client_public_key") == identity.wgPublic) { "Invitation belongs to another phone" }
            pendingBundle = text
            val request = VpnService.prepare(this)
            if (request != null) vpn.launch(request) else finishPairing()
        } catch (e: Exception) { error = e.message ?: "Invalid enrollment" }
    }
    private fun finishPairing() {
        val text = pendingBundle ?: return
        busy = true; error = null
        scope.launch {
            try {
                identity.bundle = text
                withContext(Dispatchers.IO) {
                    HomeTunnel.connect(this@MainActivity, identity, JSONObject(text))
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
            finally { busy = false }
        }
    }
    private fun startSharing() {
        val needed = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        permissions.launch(needed.toTypedArray())
    }
    @Composable private fun LockScreen() {
        Column(Modifier.fillMaxSize().padding(38.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Outlined.Fingerprint, null, Modifier.size(65.dp), tint = Purple)
            Spacer(Modifier.height(26.dp)); Text("A private place.", fontSize = 29.sp, fontWeight = FontWeight.SemiBold)
            Text("Unlock to see your household connection.", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(vertical = 13.dp))
            Button(onClick = { unlock() }, modifier = Modifier.fillMaxWidth().padding(top = 20.dp), shape = RoundedCornerShape(13.dp)) { Text("Unlock Bungee", Modifier.padding(7.dp)) }
            error?.let { Text(it, color = Color(0xFFB97777), fontSize = 12.sp, modifier = Modifier.padding(top = 15.dp)) }
        }
    }
    @Composable private fun HomeScreen() {
        val status by TelemetryService.status.collectAsState()
        var lockEnabled by remember { mutableStateOf(identity.appLock) }
        var locate by remember { mutableStateOf(identity.allowLocate) }
        var commands by remember { mutableStateOf(identity.allowCommands) }
        var confirmReset by remember { mutableStateOf(false) }
        var recovery by remember { mutableStateOf(identity.recoveryMessage) }
        Column(Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 25.dp)) {
            Row(Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 35.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(36.dp).background(Purple, RoundedCornerShape(11.dp)), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Sensors, null, tint = Color.White, modifier = Modifier.size(23.dp)) }
                Text(" bungee.", fontSize = 27.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f)); Icon(Icons.Outlined.Shield, "Self hosted", tint = Muted, modifier = Modifier.size(22.dp))
            }
            Text("CONNECTED, ON YOUR TERMS", letterSpacing = 2.sp, fontSize = 9.sp, color = Color(0xFF9D92B0), fontWeight = FontWeight.SemiBold)
            Text(if (enrolled) "A little closer to home." else "Give your phone\na private way home.", fontSize = 30.sp, lineHeight = 37.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
            Text(if (enrolled) "Your household. Your server. Your peace of mind." else "Find it. Ring it. Keep it close.\nYour data stays with the people you trust.", fontSize = 12.sp, lineHeight = 21.sp, color = Muted, modifier = Modifier.padding(top = 13.dp, bottom = 26.dp))
            if (!enrolled) {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(22.dp)) {
                        Icon(Icons.Outlined.Key, null, tint = Purple, modifier = Modifier.size(27.dp))
                        Text("A key that belongs to you.", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
                        Text("Copy this public key into “Add a device” on your home server. Your private keys stay on this phone.", fontSize = 12.sp, lineHeight = 20.sp, color = Muted, modifier = Modifier.padding(top = 9.dp, bottom = 17.dp))
                        Text(identity.wgPublic, fontSize = 11.sp, color = Purple, modifier = Modifier.fillMaxWidth().background(Color(0xFFF4F1FB), RoundedCornerShape(10.dp)).clickable {
                            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Bungee WireGuard public key", identity.wgPublic))
                            android.widget.Toast.makeText(this@MainActivity, "Public key copied", android.widget.Toast.LENGTH_SHORT).show()
                        }.padding(13.dp))
                        Button(onClick = { scan.launch(ScanOptions().setPrompt("Scan your Bungee enrollment invitation").setBeepEnabled(false).setOrientationLocked(false)) }, modifier = Modifier.fillMaxWidth().padding(top = 18.dp), shape = RoundedCornerShape(11.dp), enabled = !busy) {
                            Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp)); Text("  Scan invitation", Modifier.padding(6.dp))
                        }
                        TextButton(onClick = { showPairing = true }, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Paste enrollment text instead", fontSize = 11.sp) }
                    }
                }
            } else {
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(20.dp)) {
                    Column(Modifier.padding(22.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(45.dp).background(Color(0xFFECF5EF), RoundedCornerShape(13.dp)), contentAlignment = Alignment.Center) { Icon(if (status.connected) Icons.Outlined.Wifi else Icons.Outlined.Pause, null, tint = Color(0xFF6E9E80)) }
                            Column(Modifier.padding(start = 13.dp)) { Text(if (status.connected) "Home is within reach." else if (status.running) "Finding the way home…" else "Take a little pause.", fontSize = 14.sp, fontWeight = FontWeight.SemiBold); Text(status.text, fontSize = 10.sp, color = Muted, modifier = Modifier.padding(top = 5.dp)) }
                        }
                        HorizontalDivider(Modifier.padding(vertical = 20.dp), color = Color(0xFFF0EDF5))
                        Row { Icon(Icons.Outlined.VpnLock, null, tint = Purple, modifier = Modifier.size(17.dp)); Text("  Only household traffic uses the tunnel.", fontSize = 11.sp, color = Muted) }
                        Text("Your browsing, calls, and other apps use their normal connection. Android allows one VPN per profile.", color = Muted, fontSize = 11.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 10.dp))
                        status.lastSent?.let { Text("Last check-in · ${java.text.DateFormat.getTimeInstance().format(java.util.Date(it))}", color = Color(0xFF9BA99F), fontSize = 10.sp, modifier = Modifier.padding(top = 16.dp)) }
                        Button(onClick = { if (status.running) stopService(Intent(this@MainActivity, TelemetryService::class.java)) else startSharing() }, modifier = Modifier.fillMaxWidth().padding(top = 20.dp), shape = RoundedCornerShape(11.dp)) { Text(if (status.running) "Pause sharing" else "Start sharing", Modifier.padding(6.dp)) }
                    }
                }
                Text("YOU’RE IN CONTROL", color = Muted, fontSize = 9.sp, letterSpacing = 1.8.sp, modifier = Modifier.padding(top = 30.dp, bottom = 15.dp))
                Card(colors = CardDefaults.cardColors(containerColor = Color.White), shape = RoundedCornerShape(17.dp)) {
                    Column(Modifier.padding(horizontal = 18.dp)) {
                        SettingRow("Share GPS history", "Saved on your server until erased; precise location required", locate) { locate = it; identity.allowLocate = it }
                        HorizontalDivider(color = Color(0xFFF4F1F7))
                        SettingRow("Household commands", "Sound, recovery messages & permitted locking", commands) { commands = it; identity.allowCommands = it }
                        HorizontalDivider(color = Color(0xFFF4F1F7))
                        SettingRow("Lock this app", "Use your phone’s secure screen lock", lockEnabled) { enabled ->
                            unlock { identity.appLock = enabled; lockEnabled = enabled; locked = false }
                        }
                    }
                }
                TextButton(onClick = { startActivity(Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, ComponentName(this@MainActivity, BungeeAdminReceiver::class.java)).putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Optional: let your household lock this phone. No remote wipe.")) }, modifier = Modifier.padding(top = 9.dp)) {
                    Icon(Icons.Outlined.AdminPanelSettings, null, Modifier.size(17.dp)); Text("  Enable optional remote locking", fontSize = 11.sp)
                }
                if (recovery != null) Card(Modifier.fillMaxWidth().padding(top = 15.dp), colors = CardDefaults.cardColors(containerColor = Color(0xFFF0EBF8))) {
                    Column(Modifier.padding(18.dp)) { Text("From your household", fontWeight = FontWeight.SemiBold, fontSize = 12.sp); Text(recovery!!, fontSize = 13.sp, modifier = Modifier.padding(top = 9.dp)); TextButton(onClick = { unlock { identity.recoveryMessage = null; recovery = null; getSystemService(NotificationManager::class.java).cancel(2) } }) { Text("Dismiss after unlocking", fontSize = 10.sp) } }
                }
                TextButton(onClick = { confirmReset = true }) { Text("Unpair this phone", color = Color(0xFFB78C94), fontSize = 11.sp) }
            }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 20.dp), color = Purple)
            error?.let { Text(it, color = Color(0xFFB97777), fontSize = 12.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 18.dp)) }
            Row(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.FavoriteBorder, null, Modifier.size(13.dp), tint = Color(0xFFB6A9BC)); Text("  Home is the cloud.", fontSize = 10.sp, color = Muted)
            }
            Text("Early release · test device recommended · no Google Play services required", color = Color(0xFFB0ABB9), fontSize = 9.sp, modifier = Modifier.padding(bottom = 22.dp))
        }
        if (showPairing) AlertDialog(onDismissRequest = { if (!busy) showPairing = false }, title = { Text("Connect to your home") }, text = {
            Column { Text("This creates a private tunnel and shares your phone’s location and battery with the server you chose. Timestamped GPS history stays on that server until explicitly erased or the device is revoked. Unsent GPS fixes are encrypted on this phone, up to 10,080 points. Continue only if you consent.", fontSize = 12.sp, lineHeight = 20.sp); OutlinedTextField(value = pairingText, onValueChange = { pairingText = it }, label = { Text("Enrollment invitation") }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp), minLines = 4); error?.let { Text(it, color = Color(0xFFB97777), fontSize = 11.sp) } }
        }, confirmButton = { TextButton(onClick = { pair(pairingText) }, enabled = !busy) { Text("Agree & pair") } }, dismissButton = { TextButton(onClick = { showPairing = false }, enabled = !busy) { Text("Cancel") } })
        if (confirmReset) AlertDialog(onDismissRequest = { confirmReset = false }, title = { Text("Unpair this phone?") }, text = { Text("This erases local keys and stops sharing. Also revoke this device on the server to erase its location history and remove the peer.") }, confirmButton = { TextButton(onClick = { unlock {
            stopService(Intent(this@MainActivity, TelemetryService::class.java))
            scope.launch { withContext(Dispatchers.IO) { HomeTunnel.disconnect() }; identity.reset(); identity = Identity(this@MainActivity); enrolled = false; confirmReset = false }
        } }) { Text("Unpair") } }, dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Keep paired") } })
    }
    @Composable private fun SettingRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text(title, fontSize = 12.sp, fontWeight = FontWeight.Medium); Text(subtitle, fontSize = 9.sp, lineHeight = 15.sp, color = Muted, modifier = Modifier.padding(top = 4.dp)) }
            Switch(checked = checked, onCheckedChange = onChange, modifier = Modifier.padding(start = 10.dp))
        }
    }
}
