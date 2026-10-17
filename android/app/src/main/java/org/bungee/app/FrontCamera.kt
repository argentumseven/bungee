package org.bungee.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.hardware.camera2.*
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.ImageReader
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream

/** Camera2 only. Open for one bounded still capture; no preview, microphone, flash or continuous stream. */
object FrontCamera {
    fun cameraId(context: Context): String {
        val manager = context.getSystemService(CameraManager::class.java)
        return manager.cameraIdList.firstOrNull {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
        } ?: error("This phone has no available front camera")
    }
    suspend fun capture(context: Context): ByteArray = suspendCancellableCoroutine { continuation ->
        val handler = Handler(Looper.getMainLooper())
        var camera: CameraDevice? = null
        var session: CameraCaptureSession? = null
        var reader: ImageReader? = null
        var finished = false
        fun close() { runCatching { session?.close() }; runCatching { camera?.close() }; runCatching { reader?.close() } }
        fun finish(bytes: ByteArray? = null) {
            if (finished) return
            finished = true; close()
            if (bytes == null) continuation.cancel(java.util.concurrent.CancellationException("Front camera unavailable or capture interrupted"))
            else continuation.resumeWith(Result.success(bytes))
        }
        continuation.invokeOnCancellation { handler.post { finish() } }
        handler.post {
            if (!continuation.isActive) { finish(); return@post }
            try {
                check(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
                val manager = context.getSystemService(CameraManager::class.java)
                val id = cameraId(context)
                val info = manager.getCameraCharacteristics(id)
                val size = info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.JPEG)
                    ?.filter { it.width <= 1280 && it.height <= 1280 && it.width.toLong() * it.height <= 1_228_800 }
                    ?.minByOrNull { it.width.toLong() * it.height } ?: error("No bounded still-capture size is available")
                reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 1).also { output ->
                    output.setOnImageAvailableListener({ r ->
                        try {
                            r.acquireLatestImage()?.use { image ->
                                val buffer = image.planes[0].buffer
                                check(buffer.remaining() <= 2 * 1024 * 1024)
                                val bytes = ByteArray(buffer.remaining()); buffer.get(bytes)
                                finish(bytes)
                            }
                        } catch (_: Exception) { finish() }
                    }, handler)
                }
                manager.openCamera(id, object : CameraDevice.StateCallback() {
                    override fun onOpened(device: CameraDevice) {
                        if (finished || !continuation.isActive) { device.close(); return }
                        camera = device
                        try {
                            val surface = checkNotNull(reader).surface
                            device.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR,
                                listOf(OutputConfiguration(surface)), ContextCompat.getMainExecutor(context), object : CameraCaptureSession.StateCallback() {
                                    override fun onConfigured(configured: CameraCaptureSession) {
                                        if (finished || !continuation.isActive) { configured.close(); return }
                                        session = configured
                                        try {
                                            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                                                addTarget(surface)
                                                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                                                set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF)
                                                set(CaptureRequest.JPEG_QUALITY, 60.toByte())
                                            }.build()
                                            configured.capture(request, object : CameraCaptureSession.CaptureCallback() {
                                                override fun onCaptureFailed(s: CameraCaptureSession, r: CaptureRequest, f: CaptureFailure) { finish() }
                                            }, handler)
                                        } catch (_: Exception) { finish() }
                                    }
                                    override fun onConfigureFailed(s: CameraCaptureSession) { s.close(); finish() }
                                }))
                        } catch (_: Exception) { finish() }
                    }
                    override fun onDisconnected(device: CameraDevice) { device.close(); finish() }
                    override fun onError(device: CameraDevice, error: Int) { device.close(); finish() }
                }, handler)
            } catch (_: Exception) { finish() }
        }
    }
    /** Decode/re-encode strips EXIF, bounds dimensions and avoids retaining the original camera file. */
    fun privateJpeg(bytes: ByteArray, rotation: Int): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        check(bounds.outWidth in 1..1280 && bounds.outHeight in 1..1280 && bounds.outWidth.toLong() * bounds.outHeight <= 1_228_800) { "Camera returned unexpected image dimensions" }
        val source = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error("Camera returned an unreadable image")
        try {
            val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
            val oriented = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            try {
                for (edge in listOf(320, 160)) {
                    val ratio = minOf(1.0, edge.toDouble() / maxOf(oriented.width, oriented.height))
                    val scaled = Bitmap.createScaledBitmap(oriented, (oriented.width * ratio).toInt().coerceAtLeast(1), (oriented.height * ratio).toInt().coerceAtLeast(1), true)
                    try {
                        val output = ByteArrayOutputStream()
                        check(scaled.compress(Bitmap.CompressFormat.JPEG, 60, output))
                        if (output.size() <= PhotoOutbox.MAX_BYTES) return output.toByteArray()
                    } finally { if (scaled !== oriented) scaled.recycle() }
                }
                error("Camera image exceeds the private upload limit")
            } finally { if (oriented !== source) oriented.recycle() }
        } finally { source.recycle() }
    }
}
