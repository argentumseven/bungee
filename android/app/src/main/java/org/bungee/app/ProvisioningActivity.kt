package org.bungee.app

import android.app.Activity
import android.os.Bundle

/** Enrollment is refused: ownership cannot guarantee removal without a factory reset. */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); setResult(RESULT_CANCELED); finish() }
}
class ProvisioningComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); setResult(RESULT_CANCELED); finish() }
}
