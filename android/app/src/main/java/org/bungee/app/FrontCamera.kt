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
import android.os.SystemClock
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine

/** Camera2 only. Open for one bounded still capture; no visible preview, microphone or flash. A brief discarded metering stream prepares exposure/focus. */
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
        var meter: ImageReader? = null
        var finished = false
        fun close() { runCatching { session?.close() }; runCatching { camera?.close() }; runCatching { reader?.close() }; runCatching { meter?.close() } }
        fun finish(bytes: ByteArray? = null, reason: String = "Camera interrupted or unavailable") {
            if (finished) return
            finished = true; close()
            if (!continuation.isActive) return
            if (bytes == null) continuation.resumeWith(Result.failure(IllegalStateException(reason)))
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
                val configuration=info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: error("Camera output sizes unavailable")
                val dimensions=RecoveryPhotoPolicy.captureSize(configuration.getOutputSizes(ImageFormat.JPEG)?.map { it.width to it.height } ?: emptyList())
                    ?: error("No bounded still-capture size is available")
                val size=android.util.Size(dimensions.first,dimensions.second)
                val previewSize=configuration.getOutputSizes(ImageFormat.YUV_420_888)?.filter { it.width<=640 && it.height<=640 }?.minByOrNull { it.width.toLong()*it.height }
                if (previewSize!=null) meter=ImageReader.newInstance(previewSize.width,previewSize.height,ImageFormat.YUV_420_888,2).apply {
                    setOnImageAvailableListener({ output -> runCatching { output.acquireLatestImage()?.close() } },handler)
                }
                reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 1).also { output ->
                    output.setOnImageAvailableListener({ r ->
                        try {
                            r.acquireLatestImage()?.use { image ->
                                val buffer = image.planes[0].buffer
                                check(buffer.remaining() <= RecoveryPhotoPolicy.MAX_SOURCE_BYTES)
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
                            val autofocus=info.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)==true
                            fun configure(withMeter: Boolean) {
                                val outputs=mutableListOf(OutputConfiguration(surface))
                                if (withMeter) outputs.add(OutputConfiguration(checkNotNull(meter).surface))
                                device.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR,outputs,
                                    ContextCompat.getMainExecutor(context),object:CameraCaptureSession.StateCallback() {
                                    override fun onConfigured(configured: CameraCaptureSession) {
                                        if (finished || !continuation.isActive) { configured.close(); return }
                                        session=configured
                                        var issued=false
                                        fun captureStill() {
                                            if (issued || finished || !continuation.isActive) return
                                            issued=true
                                            try {
                                                if(withMeter) configured.stopRepeating()
                                                val request=device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                                                    addTarget(surface)
                                                    set(CaptureRequest.CONTROL_AE_MODE,CaptureRequest.CONTROL_AE_MODE_ON)
                                                    set(CaptureRequest.CONTROL_AWB_MODE,CaptureRequest.CONTROL_AWB_MODE_AUTO)
                                                    if(autofocus) set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                                                    set(CaptureRequest.FLASH_MODE,CaptureRequest.FLASH_MODE_OFF)
                                                    set(CaptureRequest.JPEG_QUALITY,95.toByte())
                                                }.build()
                                                configured.capture(request,object:CameraCaptureSession.CaptureCallback() {
                                                    override fun onCaptureFailed(s:CameraCaptureSession,r:CaptureRequest,f:CaptureFailure){finish(reason="Android rejected still capture (reason ${f.reason})")}
                                                },handler)
                                            } catch(_:Exception){finish()}
                                        }
                                        if(!withMeter){captureStill();return}
                                        try {
                                            val started=SystemClock.elapsedRealtime()
                                            var frames=0
                                            val request=device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                                addTarget(checkNotNull(meter).surface)
                                                set(CaptureRequest.CONTROL_AE_MODE,CaptureRequest.CONTROL_AE_MODE_ON)
                                                set(CaptureRequest.CONTROL_AWB_MODE,CaptureRequest.CONTROL_AWB_MODE_AUTO)
                                                if(autofocus) set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                                            }.build()
                                            configured.setRepeatingRequest(request,object:CameraCaptureSession.CaptureCallback() {
                                                override fun onCaptureCompleted(s:CameraCaptureSession,r:CaptureRequest,result:TotalCaptureResult) {
                                                    frames++
                                                    val ae=result.get(CaptureResult.CONTROL_AE_STATE)
                                                    val af=result.get(CaptureResult.CONTROL_AF_STATE)
                                                    val awb=result.get(CaptureResult.CONTROL_AWB_STATE)
                                                    val exposed=ae==null || ae in listOf(CaptureResult.CONTROL_AE_STATE_CONVERGED,CaptureResult.CONTROL_AE_STATE_LOCKED,CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED)
                                                    val focused=!autofocus || af==null || af in listOf(CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED,CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED)
                                                    val balanced=awb==null || awb in listOf(CaptureResult.CONTROL_AWB_STATE_CONVERGED,CaptureResult.CONTROL_AWB_STATE_LOCKED)
                                                    if(frames>=3 && SystemClock.elapsedRealtime()-started>=250 && exposed && focused && balanced) captureStill()
                                                }
                                            },handler)
                                            handler.postDelayed({captureStill()},1500)
                                        } catch(_:Exception){captureStill()}
                                    }
                                    override fun onConfigureFailed(failed:CameraCaptureSession) {
                                        failed.close()
                                        if(finished || !continuation.isActive)return
                                        if(withMeter) { runCatching {meter?.close()};meter=null;runCatching{configure(false)}.onFailure{finish()} }
                                        else finish(reason="Android could not configure the front camera")
                                    }
                                }))
                            }
                            configure(meter!=null)
                        } catch (_: Exception) { finish() }
                    }
                    override fun onDisconnected(device: CameraDevice) { device.close(); finish(reason="Front camera disconnected") }
                    override fun onError(device: CameraDevice, error: Int) { device.close(); finish(reason=when(error) {
                        ERROR_CAMERA_IN_USE, ERROR_MAX_CAMERAS_IN_USE -> "Camera busy in another app"
                        ERROR_CAMERA_DISABLED -> "Android disabled camera access while locked or by policy"
                        else -> "Android camera error $error"
                    }) }
                }, handler)
            } catch (_: Exception) { finish() }
        }
    }
    /** Decode/re-encode strips EXIF, bounds dimensions and avoids retaining the original camera file. */
    fun privateJpeg(bytes: ByteArray, rotation: Int): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val sample=RecoveryPhotoPolicy.decodeSample(bounds.outWidth,bounds.outHeight)
        val source = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize=sample }) ?: error("Camera returned an unreadable image")
        try {
            val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
            val oriented = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            try {
                val output=BoundedPhotoOutput(PhotoOutbox.MAX_BYTES)
                for (edge in listOf(RecoveryPhotoPolicy.MAX_EDGE,1600,1280)) {
                    val ratio = minOf(1.0, edge.toDouble() / maxOf(oriented.width, oriented.height))
                    val scaled = Bitmap.createScaledBitmap(oriented, (oriented.width * ratio).toInt().coerceAtLeast(1), (oriented.height * ratio).toInt().coerceAtLeast(1), true)
                    try {
                        for(quality in listOf(90,85,80)) {
                            output.reset()
                            check(scaled.compress(Bitmap.CompressFormat.JPEG,quality,output))
                            output.complete()?.let { return it }
                        }
                    } finally { if (scaled !== oriented) scaled.recycle() }
                }
                error("Camera image exceeds the private upload limit")
            } finally { if (oriented !== source) oriented.recycle() }
        } finally { source.recycle() }
    }
}
