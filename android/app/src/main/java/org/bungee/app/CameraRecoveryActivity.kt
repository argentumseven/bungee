package org.bungee.app

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.withResumed
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first

/** A real, bounded visible activity. No transparent window, lock-screen flag or credential prompt. */
class CameraRecoveryActivity : FragmentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val handler = Handler(Looper.getMainLooper())
    private val close = Runnable { ArmedCameraService.showAttention(this); finish() }
    override fun onCreate(savedInstanceState: Bundle?) {
        AppearancePreference.applyTo(this)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (savedInstanceState != null || !CameraBootRecovery.consume(this, intent.getStringExtra("request_key"))) { finish(); return }
        val pad = (28 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(pad, pad, pad, pad)
        }
        val size = (80 * resources.displayMetrics.density).toInt()
        layout.addView(ImageView(this).apply { setImageResource(R.drawable.bungee_mark); contentDescription = null }, LinearLayout.LayoutParams(size, size))
        layout.addView(TextView(this).apply { text = "Restoring theft protection"; textSize = 22f; gravity = Gravity.CENTER; setPadding(0, pad, 0, pad / 2) })
        val detail = TextView(this).apply { text = "Bungee is resuming the camera protection you enabled. No action is needed; this screen closes automatically."; textSize = 15f; gravity = Gravity.CENTER }
        layout.addView(detail, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        layout.addView(ProgressBar(this), LinearLayout.LayoutParams(pad, pad).apply { topMargin = pad })
        layout.addView(Button(this).apply { text = "Close screen"; setOnClickListener { finish() } }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = pad })
        setContentView(ScrollView(this).apply {
            isFillViewport = true; fitsSystemWindows = true
            addView(layout, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        })
        // A failed service/permission must never leave a persistent foreground screen.
        handler.postDelayed(close, 12_000)
        scope.launch {
            try {
                lifecycle.withResumed {
                    check(CameraBootRecovery.allowed(this@CameraRecoveryActivity)) { "Automatic camera recovery was disabled" }
                    ArmedCameraService.resume(this@CameraRecoveryActivity)
                }
                val result = withTimeout(10_000) { ArmedCameraService.status.first { it.armed || !LocalSafety.isCameraEnabled(this@CameraRecoveryActivity) } }
                if (!result.armed) return@launch
                detail.text = "Theft photos are ready."
                delay(400)
            } catch (e: Exception) {
                if (e is CancellationException && !isActive) throw e
                ArmedCameraService.showAttention(this@CameraRecoveryActivity)
            } finally { if (isActive) finish() }
        }
    }
    override fun onDestroy() { handler.removeCallbacks(close); scope.cancel(); super.onDestroy() }
}
