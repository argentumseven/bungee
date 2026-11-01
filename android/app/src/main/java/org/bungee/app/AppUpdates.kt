package org.bungee.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

data class AppRelease(val version: String, val code: Long, val sha: String, val signer: String, val size: Long) {
    companion object {
        fun parse(json: JSONObject): AppRelease {
            val release = AppRelease(json.getString("version"), json.getLong("version_code"), json.getString("sha256"), json.getString("signer_sha256"), json.getLong("size"))
            require(release.version.length in 1..60 && release.code in 1..2_100_000_000L && release.size in 1..256L*1024*1024)
            require(release.sha.matches(Regex("[a-f0-9]{64}")) && release.signer.matches(Regex("[a-f0-9]{64}")))
            return release
        }
    }
    fun compatible(installedCode: Long, installedSigner: String) = code > installedCode && signer == installedSigner
}

object AppUpdates {
    data class Status(val release: AppRelease? = null, val message: String = "The paired server selects the phone version.", val progress: Int? = null, val ready: Boolean = false)
    private val mutable = MutableStateFlow(Status())
    private val downloads = Mutex()
    val status = mutable.asStateFlow()
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun digest(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer=ByteArray(64*1024); while (true) {val size=input.read(buffer);if(size<0) break;digest.update(buffer,0,size)} }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    @Suppress("DEPRECATION")
    private fun installedSigner(context: Context): String {
        val info=context.packageManager.getPackageInfo(context.packageName,PackageManager.GET_SIGNING_CERTIFICATES)
        val signers=checkNotNull(info.signingInfo).apkContentsSigners
        require(signers.size==1) { "Multiple app signers are unsupported" }
        return sha(signers.single().toByteArray())
    }
    fun observe(context: Context, json: JSONObject?) {
        if (json == null) {
            if(mutable.value.progress==null) mutable.value=Status(message="The server is preparing its APK. Check again shortly.")
            return
        }
        val release=AppRelease.parse(json)
        if(mutable.value.release==release && (mutable.value.progress!=null || mutable.value.ready)) return
        if(release.code<=BuildConfig.VERSION_CODE) directory(context).listFiles()?.forEach {it.delete()}
        val signer=installedSigner(context)
        mutable.value=Status(release, when {
            release.signer!=signer -> "This old APK has a different signing key. Download the server’s APK in manager Settings → Phone app updates. Reconnect your saved device to keep its history."
            release.code>BuildConfig.VERSION_CODE -> "Bungee ${release.version} is available from your paired server."
            release.code==BuildConfig.VERSION_CODE.toLong() -> "Bungee ${BuildConfig.VERSION_NAME} is up to date with your server."
            else -> "Your phone is newer than the server. Update the server first; app downgrades are blocked."
        })
    }
    fun canDownload(context: Context) = mutable.value.release?.compatible(BuildConfig.VERSION_CODE.toLong(), installedSigner(context)) == true
    fun fail(message: String) { mutable.value=mutable.value.copy(message=message,progress=null) }
    private fun directory(context: Context)=File(context.cacheDir,"app-updates").apply { mkdirs() }
    suspend fun download(context: Context, identity: Identity) = downloads.withLock {
        val release=checkNotNull(mutable.value.release)
        check(release.compatible(BuildConfig.VERSION_CODE.toLong(),installedSigner(context))) { "This APK cannot replace the installed version" }
        val dir=directory(context)
        // Only this private directory is ever shared with the Android installer.
        dir.listFiles()?.filter {it.name!=release.sha+".part" && it.name!=release.sha+".apk"}?.forEach {it.delete()}
        val part=File(dir,release.sha+".part")
        val target=File(dir,release.sha+".apk")
        if (target.exists()) {
            try {
                validate(context,target,release)
                mutable.value=Status(release,"Download verified. Android will ask you to approve the update.",ready=true);return@withLock
            } catch(_:Exception) { check(target.delete()) { "Cannot remove a damaged APK" } }
        }
        val api=HomeApi(identity)
        RandomAccessFile(part,"rw").use { output ->
            var offset=output.length().coerceAtMost(release.size)
            if(offset!=release.size) offset=offset/131072*131072
            output.setLength(offset);output.seek(offset)
            check(dir.usableSpace >= release.size-offset+128L*1024*1024) { "Free more phone storage before downloading this update" }
            while (offset<release.size) {
                currentCoroutineContext().ensureActive()
                check(identity.requestsAllowed()) { "Sharing stopped or pairing changed; download paused" }
                mutable.value=Status(release,"Downloading from your paired server…",(offset*100/release.size).toInt())
                val chunk=api.request("/v1/app-update/chunk",JSONObject().put("sha256",release.sha).put("offset",offset))
                check(chunk.getString("sha256")==release.sha && chunk.getLong("offset")==offset)
                val encoded=chunk.getString("data")
                require(encoded.length<=174764)
                val bytes=android.util.Base64.decode(encoded,android.util.Base64.NO_WRAP)
                require(bytes.size.toLong()==minOf(131072L,release.size-offset))
                check(dir.usableSpace>=bytes.size+128L*1024*1024) { "Phone storage is low; download paused" }
                output.write(bytes);offset+=bytes.size
                if(offset%(16*131072)==0L) output.fd.sync()
            }
            output.fd.sync()
        }
        try { validate(context,part,release) } catch(e:Exception) {part.delete();throw e}
        check(part.renameTo(target)) { "Cannot save verified APK" }
        mutable.value=Status(release,"Download verified. Android will ask you to approve the update.",ready=true)
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
