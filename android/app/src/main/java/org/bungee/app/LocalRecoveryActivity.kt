package org.bungee.app

import android.app.AlertDialog
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.*

/** A separate launcher entry: no Identity, server, Compose, QR, or native tunnel initialization. */
class LocalRecoveryActivity : FragmentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var result: TextView
    private var recoveryRunning = false
    override fun onCreate(savedInstanceState: Bundle?) {
        AppearancePreference.applyTo(this)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(32), dp(24), dp(24)) }
        content.addView(TextView(this).apply { text = "Bungee · local recovery"; textSize = 25f })
        content.addView(TextView(this).apply {
            text = "Works offline without pairing keys. Stop remote controls and attempt to release older Bungee policies. This does not erase phone data, change your PIN, remove Android device/profile ownership or factory-reset the phone.\n\nFor an ordinary personal installation, you can also deactivate Bungee device administration, force-stop or uninstall it in Android Settings."
            textSize = 16f; setPadding(0, dp(16), 0, dp(16))
        })
        content.addView(Button(this).apply { text = "Stop Bungee and release old policies"; setOnClickListener { authenticate { recover() } } })
        content.addView(Button(this).apply { text = "Open Android app settings"; setOnClickListener {
            startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName")))
        } })
        content.addView(Button(this).apply { text = "Allow a manual restart"; setOnClickListener { authenticate {
            if (ManagementAgent.blocksPersonalOperation(this@LocalRecoveryActivity)) {
                result.text = "Android management ownership is present or unavailable. Check administration status before restarting. Preserve app data and the original signer while ownership remains."
            } else if (!LocalSafety.isStopped(this@LocalRecoveryActivity)) {
                result.text = "No local stop is set. Use Stop Bungee first if you want to stop sharing."
            } else {
                runCatching { LocalSafety.setStopped(this@LocalRecoveryActivity, false) }
                    .onSuccess { result.text = "Local stop cleared. Sharing remains stopped until you explicitly start it in Bungee." }
                    .onFailure { result.text = "The local stop could not be cleared. Android Settings remains available." }
            }
        } } })
        content.addView(Button(this).apply { text = "Check administration status"; setOnClickListener {
            if (recoveryRunning) { result.text = "Recovery is still running. Wait for the cleanup result."; return@setOnClickListener }
            scope.launch {
                result.text = withContext(Dispatchers.IO) {
                    val role = ManagementAgent.role(this@LocalRecoveryActivity)
                    role.removalNotice ?: runCatching {
                        val dpm = getSystemService(android.app.admin.DevicePolicyManager::class.java)
                        if (dpm.isAdminActive(android.content.ComponentName(this@LocalRecoveryActivity, BungeeAdminReceiver::class.java)))
                            "Bungee device administration is still active. Deactivation may be pending; check Android security settings before uninstalling."
                        else "Bungee has no device/profile ownership and no active device administration. You can uninstall it in Android Settings."
                    }.getOrDefault("Administration status could not be checked. Use Android security settings.")
                }
            }
        } })
        content.addView(Button(this).apply { text = "Open Android security settings"; setOnClickListener {
            startActivity(Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS))
        } })
        result = TextView(this).apply { textSize = 16f; setPadding(0, dp(16), 0, 0) }
        content.addView(result)
        setContentView(ScrollView(this).apply { addView(content) })
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun authenticate(action: () -> Unit) {
        if (recoveryRunning) { result.text = "Recovery is still running. Wait for the cleanup result."; return }
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isDeviceSecure) {
            if (keyguard.isDeviceLocked) { result.text = "Unlock the phone first."; return }
            AlertDialog.Builder(this).setTitle("Confirm local recovery")
                .setMessage("This phone has no secure screen lock. Confirm that you want to change Bungee's local recovery state.")
                .setPositiveButton("Confirm") { _, _ -> if (!recoveryRunning) action() }.setNegativeButton("Cancel", null).show()
            return
        }
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(authentication: BiometricPrompt.AuthenticationResult) { if (!recoveryRunning) action() }
            override fun onAuthenticationError(code: Int, message: CharSequence) { result.text = message }
        }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Bungee local recovery")
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL).build())
    }
    private fun recover() {
        recoveryRunning = true
        scope.launch {
            try {
                result.text = "Stopping Bungee and checking old policies…"
                val failures = withContext(Dispatchers.IO) {
                    val legacyIssues = mutableListOf<String>()
                    val failures = RecoveryCoordinator.run({ LocalSafety.setStopped(this@LocalRecoveryActivity, true) }, listOf(
                        "The existing home connection could not be closed. Deactivate Bungee administration, then force-stop it in Android Settings." to { RecoveryConnection.current.stop() },
                        "The camera service or pending photos could not be cleared. Deactivate Bungee administration, then force-stop it in Android Settings." to { ArmedCameraService.disarm(this@LocalRecoveryActivity) },
                        "The sharing service could not be stopped. Deactivate Bungee administration, then force-stop it in Android Settings." to { stopService(Intent(this@LocalRecoveryActivity, TelemetryService::class.java)); Unit },
                        "Recovery notifications could not be cleared." to { getSystemService(NotificationManager::class.java).cancelAll() },
                        "Some old managed policies could not be released. Review the legacy recovery guide." to {
                            legacyIssues += ManagementAgent.releaseLegacy(this@LocalRecoveryActivity)
                        }
                    ))
                    failures + legacyIssues
                }
                val role = ManagementAgent.role(this@LocalRecoveryActivity)
                result.text = when {
                    failures.isNotEmpty() -> failures.joinToString("\n\n")
                    role.blocksOperation -> "Local stop saved. Known-policy cleanup finished, but ownership remains and uninstall is not confirmed."
                    else -> "Local stop saved. Bungee will not reconnect or accept commands until you manually clear it. Device administration is inactive; you can uninstall in Android Settings."
                }
                role.removalNotice?.takeUnless { it in failures }?.let { result.append("\n\n$it") }
            } finally { recoveryRunning = false }
        }
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
