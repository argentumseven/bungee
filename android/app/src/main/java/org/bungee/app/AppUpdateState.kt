package org.bungee.app

import org.json.JSONObject

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

enum class AppUpdatePhase { IDLE, CHECKING, PREPARING, AVAILABLE, BLOCKED, CURRENT, DOWNLOADING, VERIFYING, PAUSED, READY, ERROR }

data class AppUpdateStatus(
    val release: AppRelease? = null,
    val serverVersion: String? = null,
    val phase: AppUpdatePhase = AppUpdatePhase.IDLE,
    val message: String = "Check the app version offered by your paired server.",
    val downloadedBytes: Long = 0,
    val installedSigner: String? = null,
    val updateAvailable: Boolean = false,
) {
    val signerMismatch get() = release != null && installedSigner != null && release.signer != installedSigner
    val ready get() = phase == AppUpdatePhase.READY
    val busy get() = phase in listOf(AppUpdatePhase.CHECKING, AppUpdatePhase.DOWNLOADING, AppUpdatePhase.VERIFYING)
    val progress: Int? get() = if (phase == AppUpdatePhase.DOWNLOADING && release != null) (downloadedBytes * 100 / release.size).toInt().coerceIn(0, 100) else null
    val canDownload get() = updateAvailable && release != null && phase in listOf(AppUpdatePhase.AVAILABLE, AppUpdatePhase.PAUSED, AppUpdatePhase.ERROR) && release.signer == installedSigner

    fun observed(release: AppRelease?, serverVersion: String?, preparation: JSONObject?, installedCode: Long, signer: String, explicit: Boolean = false): AppUpdateStatus {
        // Background policy sync must not erase progress, a paused download, or an actionable error.
        if (busy && !(explicit && phase == AppUpdatePhase.CHECKING)) return this
        if (release != null && this.release == release && (ready || (!explicit && phase in listOf(AppUpdatePhase.PAUSED, AppUpdatePhase.ERROR)))) return this
        val server = serverVersion ?: release?.version ?: this.serverVersion
        if (release == null) return AppUpdateStatus(serverVersion = server, phase = AppUpdatePhase.PREPARING,
            message = preparation?.optString("message")?.takeIf { it.isNotBlank() }?.take(240)
                ?: "The server has not prepared its APK yet. Open manager Settings → Phone app updates for its preparation status.", installedSigner = signer)
        val (phase, message) = when {
            release.code == installedCode -> AppUpdatePhase.CURRENT to (
                "Bungee ${release.version} is up to date with your server." +
                    if (release.signer != signer) " The signing certificates differ; matching versions do not establish update compatibility. See Signing key details." else "")
            release.code < installedCode -> AppUpdatePhase.CURRENT to "Your phone is newer than the server. Update the server first; app downgrades are blocked."
            release.signer != signer -> AppUpdatePhase.BLOCKED to "Bungee ${release.version} is available, but Android cannot install it over this app because the signing certificates differ. Open Update recovery below."
            else -> AppUpdatePhase.AVAILABLE to "Bungee ${release.version} is available from your paired server."
        }
        return AppUpdateStatus(release, server, phase, message, installedSigner = signer, updateAvailable = release.compatible(installedCode, signer))
    }
}
