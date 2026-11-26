package org.bungee.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

object AppUpdates {
    private val mutable = MutableStateFlow(AppUpdateStatus())
    private val downloads = Mutex()
    private val retryDelays = longArrayOf(1000, 3000, 8000)
    private val transientTransportFailures = setOf(
        "home server unreachable", "invalid home response", "request canceled",
        "request canceled or already used", "private connection is stopped", "too many pending home requests",
        "The private tunnel is disconnected", "The app-contained connection is unavailable"
    )
    val status = mutable.asStateFlow()
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun digest(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer=ByteArray(64*1024); while (true) {val size=input.read(buffer);if(size<0) break;digest.update(buffer,0,size)} }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    @Suppress("DEPRECATION")
    fun installedSigner(context: Context): String {
        val info=context.packageManager.getPackageInfo(context.packageName,PackageManager.GET_SIGNING_CERTIFICATES)
        val signers=checkNotNull(info.signingInfo).apkContentsSigners
        require(signers.size==1) { "Multiple app signers are unsupported" }
        return sha(signers.single().toByteArray())
    }
    fun observe(context: Context, json: JSONObject?, serverVersion: String? = null, preparation: JSONObject? = null, explicit: Boolean = false) {
        val release=json?.let { AppRelease.parse(it) }
        val signer=installedSigner(context)
        mutable.update { it.observed(release,serverVersion,preparation,BuildConfig.VERSION_CODE.toLong(),signer,explicit) }
    }
    fun fail(message: String) { mutable.update { it.copy(message=message,phase=if(it.ready) AppUpdatePhase.READY else AppUpdatePhase.ERROR) } }
    private fun connect(context: Context, identity: Identity, owner: Any) {
        // Reusing telemetry’s connection leaves ownership with the sharing service.
        HomeTunnel.connect(context, identity, JSONObject(checkNotNull(identity.bundle) { "Pair this phone first" }), owner, claimExisting = false)
    }
    private suspend fun <T> connected(context: Context, identity: Identity, action: suspend (Any) -> T): T {
        val owner=Any()
        try {
            currentCoroutineContext().ensureActive()
            connect(context, identity, owner)
            currentCoroutineContext().ensureActive()
            return action(owner)
        } finally { HomeTunnel.disconnectOwned(owner) }
    }
    suspend fun check(context: Context, identity: Identity) = downloads.withLock {
        mutable.value=mutable.value.copy(phase=AppUpdatePhase.CHECKING,message="Connecting to your paired server and checking its app version…")
        connected(context,identity) {
            val result=HomeApi(identity).request("/v1/app-update", JSONObject().put("installed_signer_sha256", installedSigner(context)))
            currentCoroutineContext().ensureActive()
            observe(context,result.optJSONObject("release"),result.optString("server_version").takeIf { it.isNotBlank() },result.optJSONObject("preparation"),explicit=true)
        }
    }
    private suspend fun fetchChunk(context: Context, identity: Identity, owner: Any, api: HomeApi, release: AppRelease, offset: Long): JSONObject {
        var attempt = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            check(identity.requestsAllowed()) { "Bungee stopped or pairing changed. Reopen Bungee before resuming." }
            try {
                if (!HomeTunnel.appContained) connect(context, identity, owner)
                return api.request("/v1/app-update/chunk", JSONObject().put("sha256", release.sha).put("offset", offset), timeoutMillis = HomeRequestBudget.CHUNK_MAX_MILLIS)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is HomeApiException && e.status == 404) {
                    throw IllegalStateException("The server replaced this APK. Check for updates again.", e)
                }
                val throttled = e is HomeApiException && e.status == 429
                val transient = if (e is HomeApiException) throttled || e.status in 500..599 || e.status == 408
                    else e.message in transientTransportFailures
                if (!transient) throw e
                if (attempt == retryDelays.size) {
                    throw IllegalStateException("Download interrupted: ${e.message}. Saved chunks are ready to resume.", e)
                }
                if (e.message == "home server unreachable") HomeTunnel.disconnectOwned(owner)
                val wait = if (throttled && attempt == retryDelays.lastIndex) 60_000L else retryDelays[attempt]
                val message = if (throttled) "The server is limiting update requests. Waiting to resume…"
                    else "Connection interrupted. Retrying from the last saved chunk…"
                mutable.update { it.copy(message = message) }
                delay(wait)
                attempt++
                mutable.update { it.copy(message = "Downloading from your paired server…") }
            }
        }
    }
    private fun directory(context: Context)=File(context.cacheDir,"app-updates").apply { mkdirs() }
    fun pause() { mutable.value=mutable.value.copy(phase=AppUpdatePhase.PAUSED,message="Download paused. Tap Resume download to continue from the saved bytes.") }
    suspend fun download(context: Context, identity: Identity) = downloads.withLock {
        mutable.value=mutable.value.copy(phase=AppUpdatePhase.DOWNLOADING,message="Connecting to download from your paired server…")
        val release=checkNotNull(mutable.value.release)
        check(release.compatible(BuildConfig.VERSION_CODE.toLong(),installedSigner(context))) { "This APK cannot replace the installed version" }
        val dir=directory(context)
        // Only this private directory is ever shared with the Android installer.
        dir.listFiles()?.filter {it.name!=release.sha+".part" && it.name!=release.sha+".apk"}?.forEach {it.delete()}
        val part=File(dir,release.sha+".part")
        val target=File(dir,release.sha+".apk")
        if (target.exists()) {
            try {
                mutable.value=mutable.value.copy(phase=AppUpdatePhase.VERIFYING,message="Verifying the saved APK checksum, version and signing key…")
                validate(context,target,release)
                mutable.value=mutable.value.copy(phase=AppUpdatePhase.READY,message="Download verified. Tap Install update; Android will ask for confirmation.");return@withLock
            } catch(_:Exception) { check(target.delete()) { "Cannot remove a damaged APK" } }
        }
        connected(context,identity) { owner ->
            val api=HomeApi(identity)
            RandomAccessFile(part,"rw").use { output ->
                var offset=output.length().coerceAtMost(release.size)
                if(offset!=release.size) offset=offset/131072*131072
                output.setLength(offset);output.seek(offset)
                check(dir.usableSpace >= release.size-offset+128L*1024*1024) { "Free more phone storage before downloading this update" }
                while (offset<release.size) {
                    currentCoroutineContext().ensureActive()
                    mutable.update { it.copy(message="Downloading from your paired server…",downloadedBytes=offset) }
                    val chunk=fetchChunk(context, identity, owner, api, release, offset)
                    check(chunk.getString("sha256")==release.sha && chunk.getLong("offset")==offset)
                    val encoded=chunk.getString("data")
                    require(encoded.length<=174764)
                    val bytes=android.util.Base64.decode(encoded,android.util.Base64.NO_WRAP)
                    require(bytes.size.toLong()==minOf(131072L,release.size-offset))
                    check(dir.usableSpace>=bytes.size+128L*1024*1024) { "Phone storage is low; download paused" }
                    currentCoroutineContext().ensureActive()
                    output.write(bytes);offset+=bytes.size
                    mutable.value=mutable.value.copy(downloadedBytes=offset)
                    if(offset%(16*131072)==0L) output.fd.sync()
                }
                output.fd.sync()
            }
        }
        currentCoroutineContext().ensureActive()
        mutable.value=mutable.value.copy(phase=AppUpdatePhase.VERIFYING,message="Verifying APK checksum, version and signing key…",downloadedBytes=release.size)
        try { validate(context,part,release) } catch(e:Exception) {part.delete();throw e}
        check(part.renameTo(target)) { "Cannot save verified APK" }
        mutable.value=mutable.value.copy(phase=AppUpdatePhase.READY,message="Download verified. Tap Install update; Android will ask for confirmation.")
    }
    @Suppress("DEPRECATION")
    private fun validate(context: Context, file: File, release: AppRelease) {
        require(file.length()==release.size && digest(file)==release.sha) { "APK checksum mismatch; retry the download" }
        val info=checkNotNull(context.packageManager.getPackageArchiveInfo(file.path,PackageManager.GET_SIGNING_CERTIFICATES)) { "Invalid APK" }
        require(info.packageName==context.packageName && info.longVersionCode==release.code && info.versionName==release.version) { "APK version/package mismatch" }
        val signers=checkNotNull(info.signingInfo).apkContentsSigners
        require(signers.size==1 && sha(signers.single().toByteArray())==release.signer && release.signer==installedSigner(context)) { "APK signer differs; update rejected" }
        require(release.code>BuildConfig.VERSION_CODE) { "App downgrades and reinstallations are blocked" }
    }
    suspend fun install(activity: Activity) {
        val release=checkNotNull(mutable.value.release)
        val file=File(directory(activity),release.sha+".apk")
        withContext(Dispatchers.IO) { validate(activity,file,release) }
        if(!activity.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:${activity.packageName}")))
            mutable.value=mutable.value.copy(message="Allow updates from Bungee, return here, then tap Install update.")
            return
        }
        val uri=FileProvider.getUriForFile(activity,activity.packageName+".updates",file)
        activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }
}
