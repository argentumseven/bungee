package org.bungee.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.PowerManager
import androidx.core.content.ContextCompat

/** Owns only Bungee's temporary alarm volume and torch changes. Never changes DND. */
class RecoveryAlarm(private val context: Context) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val cameras = context.getSystemService(CameraManager::class.java)
    private val prefs = context.getSharedPreferences("alarm_restore", Context.MODE_PRIVATE)
    private var player: MediaPlayer? = null
    private var torch: String? = null
    private var lit = false
    private var flashWake: PowerManager.WakeLock? = null
    init { restoreVolume() }
    fun start(prepared: MediaPlayer?, flash: Boolean) {
        stop()
        try {
            if (prepared != null) {
                val previous = audio.getStreamVolume(AudioManager.STREAM_ALARM)
                check(prefs.edit().putInt("volume", previous).commit()) { "Cannot save alarm volume" }
                audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
                player = prepared
                prepared.isLooping = false
                prepared.start()
            }
            if (flash) {
                torch = flashCamera(context) ?: error("Camera flash permission or hardware unavailable")
                flashWake = context.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Bungee:recovery-flash").apply {
                    setReferenceCounted(false)
                    acquire(35_000)
                }
                pulse()
            }
        } catch (e: Exception) { stop(); throw e }
    }
    fun pulse() {
        torch?.let { id -> lit = !lit; cameras.setTorchMode(id, lit) }
    }
    fun stop() {
        val old = player; player = null
        runCatching { old?.release() }
        val id = torch; torch = null; lit = false
        if (id != null) runCatching { cameras.setTorchMode(id, false) }
        val wake=flashWake; flashWake=null
        if (wake?.isHeld==true) runCatching { wake.release() }
        restoreVolume()
    }
    private fun restoreVolume() {
        if (!prefs.contains("volume")) return
        runCatching {
            audio.setStreamVolume(AudioManager.STREAM_ALARM, prefs.getInt("volume", 0), 0)
            check(prefs.edit().clear().commit())
        }
    }
    companion object {
        fun flashCamera(context: Context): String? = runCatching {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return null
            val manager = context.getSystemService(CameraManager::class.java)
            manager.cameraIdList.firstOrNull { id -> manager.getCameraCharacteristics(id).let {
                it.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true && it.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            } }
        }.getOrNull()
    }
}
