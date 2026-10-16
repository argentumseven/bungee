package org.bungee.app

import android.app.Activity
import android.app.AlertDialog
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle

/** Android 12+ admin-integrated provisioning; device-owner creation remains OS-controlled. */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val modes = intent.getIntegerArrayListExtra(DevicePolicyManager.EXTRA_PROVISIONING_ALLOWED_PROVISIONING_MODES)
        if (modes?.contains(DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE) != true) { setResult(RESULT_CANCELED); finish(); return }
        setResult(RESULT_OK, Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE)
            .putExtra(DevicePolicyManager.EXTRA_PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED, true))
        finish()
    }
}
class ProvisioningComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AlertDialog.Builder(this).setTitle("A household-managed phone")
            .setMessage("Android is enrolling Bungee as device owner. It can enforce recovery settings and suspend selected apps. Server pairing and optional DNS/location sharing still require approval in Bungee. No provider account is used.")
            .setPositiveButton("Continue") { _, _ -> setResult(RESULT_OK); finish() }
            .setNegativeButton("Cancel") { _, _ -> setResult(RESULT_CANCELED); finish() }
            .setCancelable(false).show()
    }
}
