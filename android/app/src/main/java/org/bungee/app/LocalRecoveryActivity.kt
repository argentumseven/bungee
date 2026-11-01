package org.bungee.app

import android.app.AlertDialog
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*

/** Internal offline fallback for damaged state; recovery is reached through the main Bungee app. */
class LocalRecoveryActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        AppearancePreference.applyTo(this)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        PairingRecoveryPanel(this) {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            finish()
        }.show()
    }
}

class PairingRecoveryPanel(private val activity: FragmentActivity, private val openBungee: () -> Unit) {
    private lateinit var result: TextView
    private var running = false
    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
    fun show(message: String = "") {
        val content = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(32), dp(24), dp(24)) }
        content.addView(TextView(activity).apply { text = "Bungee · pairing & recovery"; textSize = 25f })
        content.addView(TextView(activity).apply {
            text = "Works offline. Stopping keeps pairing and server history; it disarms the camera and clears unsent photos. Resetting removes only Bungee's local pairing and queued records. Android management repair is a separate choice."
            textSize = 16f; setPadding(0, dp(16), 0, dp(16))
        })
        fun button(label: String, whileRunning: Boolean = false, action: () -> Unit) { content.addView(Button(activity).apply { text = label; setOnClickListener { if (!running || whileRunning) action() } }) }
        button("Stop Bungee") { authenticate { work("Stopping Bungee…") {
            val issues = stop()
            if (issues.isEmpty()) "Bungee stopped. Pairing keys and server history are unchanged." else issues.joinToString("\n")
        } } }
        button("Reset pairing") { authenticate { confirmReset() } }
        button("Allow manual start · keep pairing") { authenticate { work("Allowing a manual start…") {
            check(!ManagementAgent.blocksPersonalOperation(activity)) { "Repair Bungee's Android management first. Pairing was preserved." }
            LocalSafety.setStopped(activity, false)
            returnToBungee()
            "Manual start allowed. No service was started."
        } } }
        button("Repair Bungee Android management") { authenticate {
            AlertDialog.Builder(activity).setTitle("Repair Bungee's Android management?")
                .setMessage("Stops Bungee and releases its known old restrictions and administration. If Bungee is device owner, it also asks Android to release that role. Pairing keys and server history stay intact. This does not reset the phone, change its PIN, or delete a profile. Profile ownership or an Android refusal may need a separate Android management path.")
                .setPositiveButton("Repair") { _, _ -> work("Repairing Bungee management…") {
                    val stopped = stop()
                    if (stopped.isNotEmpty()) stopped.joinToString("\n")
                    else {
                        val issues = ManagementAgent.repairOwnership(activity)
                        if (issues.isEmpty()) "Bungee's Android management is released. Pairing is preserved. You can return to Bungee or reset its pairing."
                        else issues.joinToString("\n")
                    }
                } }.setNegativeButton("Cancel", null).show()
        } }
        button("Check Android management") { work("Checking…") {
            val role = ManagementAgent.role(activity)
            role.removalNotice ?: "Bungee has no device/profile ownership. Ordinary administration, if enabled, does not block pairing reset."
        } }
        button("Open Android app settings", whileRunning = true) {
            activity.startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:${activity.packageName}")))
        }
        button("Open Android security settings", whileRunning = true) { activity.startActivity(Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS)) }
        button("Back to Bungee") { openBungee() }
        result = TextView(activity).apply { text = message; textSize = 16f; setPadding(0, dp(16), 0, 0) }
        content.addView(result)
        activity.setContentView(ScrollView(activity).apply { addView(content) })
    }
    private fun authenticate(action: () -> Unit) {
        if (running) return
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (!keyguard.isDeviceSecure) {
            if (keyguard.isDeviceLocked) { result.text = "Unlock the phone first."; return }
            AlertDialog.Builder(activity).setTitle("Confirm local Bungee change")
                .setMessage("This phone has no screen lock. Continue with this local Bungee action?")
                .setPositiveButton("Continue") { _, _ -> if (!running) action() }.setNegativeButton("Cancel", null).show()
        } else BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(authentication: BiometricPrompt.AuthenticationResult) { if (!running) action() }
            override fun onAuthenticationError(code: Int, message: CharSequence) { result.text = message }
        }).authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Bungee pairing & recovery")
            .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL).build())
    }
    private fun work(message: String, action: () -> String) {
        if (running) return
        running = true; result.text = message
        activity.lifecycleScope.launch {
            try { result.text = withContext(Dispatchers.IO) { action() } }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { result.text = "Bungee could not finish: ${e.message ?: "local storage or Android check failed"}. Sharing stays stopped if its stop was saved. No phone reset or profile deletion was requested." }
            finally { running = false }
        }
    }
    private fun stop(): List<String> = RecoveryCoordinator.run({ LocalSafety.setStopped(activity, true) }, listOf(
        "Could not close the Bungee connection; use Android Settings to force-stop Bungee." to { RecoveryConnection.current.stop() },
        "Could not finish camera cleanup." to { ArmedCameraService.disarm(activity) },
        "Could not stop sharing." to { activity.stopService(Intent(activity, TelemetryService::class.java)); Unit },
        "Could not clear Bungee notifications." to { activity.getSystemService(NotificationManager::class.java).cancelAll() }
    ))
    private fun confirmReset() {
        val fresh = CheckBox(activity).apply { text = "Generate new phone keys too (use this if keys are damaged)" }
        AlertDialog.Builder(activity).setTitle("Reset only Bungee pairing?")
            .setMessage("Stops Bungee and deletes its saved server invitation, sharing approvals and unsent GPS/photos/receipts. Server history and Android permissions/administration are unchanged. Your phone keys are kept unless selected below. Revoke and purge the old binding in the manager, then create a fresh invitation for the phone's current public key.")
            .setView(fresh)
            .setPositiveButton("Reset pairing") { _, _ ->
                val newKeys = fresh.isChecked
                work("Resetting Bungee pairing…") {
                    PairingReset.run({ ManagementAgent.role(activity) }, {
                        val issues = stop(); check(issues.isEmpty()) { issues.joinToString("\n") }
                    }, { Identity.resetExisting(activity, newKeys) }, {
                        Identity(activity) // Confirm usable keys before allowing a new manual pairing.
                        LocalSafety.setStopped(activity, false)
                    })
                    returnToBungee()
                    "Bungee pairing reset. Sharing is off; create a fresh invitation."
                }
            }.setNegativeButton("Cancel", null).show()
    }
    private fun returnToBungee() { activity.runOnUiThread { openBungee() } }
}
