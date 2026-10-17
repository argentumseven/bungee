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
            text = "Works offline without pairing keys. Stop remote controls and attempt to release older Bungee policies. This does not erase phone data, change your PIN, remove Android device ownership or factory-reset the phone.\n\nFor an ordinary personal installation, you can also deactivate Bungee device administration, force-stop or uninstall it in Android Settings."
            textSize = 16f; setPadding(0, dp(16), 0, dp(16))
        })
        content.addView(Button(this).apply { text = "Stop Bungee and release old policies"; setOnClickListener { authenticate { recover() } } })
        content.addView(Button(this).apply { text = "Open Android app settings"; setOnClickListener {
            startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName")))
        } })
        content.addView(Button(this).apply { text = "Allow a manual restart"; setOnClickListener { authenticate {
            if (ManagementAgent.isOwner(this@LocalRecoveryActivity)) {
                result.text = "Android still lists Bungee as device owner. Follow the legacy ownership recovery guide before using Bungee. Do not uninstall or replace it with a differently signed APK."
            } else if (!LocalSafety.isStopped(this@LocalRecoveryActivity)) {
                result.text = "No local stop is set. Use Stop Bungee first if you want to stop sharing."
            } else {
                runCatching { LocalSafety.setStopped(this@LocalRecoveryActivity, false) }
                    .onSuccess { result.text = "Local stop cleared. Sharing remains stopped until you explicitly start it in Bungee." }
                    .onFailure { result.text = "The local stop could not be cleared. Android Settings remains available." }
            }
        } } })
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
                        "The sharing service could not be stopped. Use Android Settings to force-stop Bungee." to { stopService(Intent(this@LocalRecoveryActivity, TelemetryService::class.java)); Unit },
                        "Recovery notifications could not be cleared." to { getSystemService(NotificationManager::class.java).cancelAll() },
                        "Some old managed policies could not be released. Review the legacy recovery guide." to {
                            legacyIssues += ManagementAgent.releaseLegacy(this@LocalRecoveryActivity)
                        }
                    ))
                    failures + legacyIssues
                }
                val owner = ManagementAgent.isOwner(this@LocalRecoveryActivity)
                result.text = if (failures.isEmpty()) "Local stop saved. Bungee will not reconnect or accept commands until you manually clear it. Old policy cleanup finished." else failures.joinToString("\n\n")
                if (owner) result.append("\n\nAndroid device ownership remains. Policy release cannot guarantee removal of that role; Android may require a reset. Do not uninstall, clear app data or change signing keys while ownership remains.")
            } finally { recoveryRunning = false }
        }
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
