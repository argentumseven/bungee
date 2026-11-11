package org.bungee.app

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Process
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** Local diagnostics survive a stopped connection. They are sent only by an approved later sync. */
object SharingHistory {
    val events = MutableStateFlow<List<SharingEvent>>(emptyList())
    val error = MutableStateFlow<String?>(null)
    private fun now() = System.currentTimeMillis() / 1000
    private fun prefs(context: Context) = context.getSharedPreferences("sharing-history", Context.MODE_PRIVATE)
    private fun state(context: Context) = JSONObject(prefs(context).getString("journal", "{}")!!)
    private fun save(context: Context, state: JSONObject) {
        check(prefs(context).edit().putString("journal", state.toString()).commit()) { "Sharing history could not be saved" }
        events.value = SharingEventJournal.events(state).asReversed()
        error.value = null
    }
    private fun change(context: Context, action: (JSONObject) -> Unit) = synchronized(this) {
        runCatching { val state = state(context); action(state); save(context, state) }
            .onFailure { error.value = "Sharing history unavailable; the sharing controls still work" }
        Unit
    }
    fun bind(context: Context, realm: String) = change(context) { state ->
        if (state.optString("realm") != realm) {
            SharingEventJournal.acknowledge(state, SharingEventJournal.events(state).map { it.id }.toSet())
            state.remove("epoch"); state.put("realm", realm); state.put("dropped", 0)
        }
    }
    fun record(context: Context, reason: SharingReason) = change(context) { state ->
        SharingEventJournal.append(state, SharingEvent.create(reason, now()))
        if (reason.kind == "stopped") state.remove("active")
    }
    fun started(context: Context, reason: SharingReason) = change(context) { state ->
        SharingEventJournal.append(state, SharingEvent.create(reason, now()))
        state.put("active", JSONObject().put("pid", Process.myPid()).put("since", now()))
    }
    fun ended(context: Context, reason: SharingReason = SharingReason.SERVICE_ENDED) = change(context) { state ->
        if (state.has("active")) {
            SharingEventJournal.append(state, SharingEvent.create(reason, now()))
            state.remove("active")
        }
    }
    fun recover(context: Context) = change(context) { state ->
        val active = state.optJSONObject("active") ?: return@change
        val previous = runCatching {
            context.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(context.packageName, active.getInt("pid"), 8)
                .filter { it.timestamp / 1000 >= active.getLong("since") }.maxByOrNull { it.timestamp }
        }.getOrNull()
        val reason = previous?.let { classifyExit(it.reason) } ?: SharingReason.UNEXPECTED_EXIT
        SharingEventJournal.append(state, SharingEvent.create(reason, now(), previous?.timestamp?.div(1000)))
        state.remove("active")
    }
    internal fun classifyExit(reason: Int): SharingReason = when (reason) {
            ApplicationExitInfo.REASON_CRASH -> SharingReason.CRASH
            ApplicationExitInfo.REASON_CRASH_NATIVE -> SharingReason.NATIVE_CRASH
            ApplicationExitInfo.REASON_ANR -> SharingReason.ANR
            ApplicationExitInfo.REASON_LOW_MEMORY -> SharingReason.LOW_MEMORY
            ApplicationExitInfo.REASON_USER_REQUESTED, ApplicationExitInfo.REASON_USER_STOPPED -> SharingReason.ANDROID_USER_STOPPED
            ApplicationExitInfo.REASON_PERMISSION_CHANGE -> SharingReason.PERMISSION_CHANGE
            ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE, ApplicationExitInfo.REASON_PACKAGE_UPDATED -> SharingReason.PACKAGE_CHANGED
            ApplicationExitInfo.REASON_UNKNOWN -> SharingReason.ANDROID_EXIT_UNKNOWN
            else -> SharingReason.SYSTEM_KILLED
        }
    fun addReport(context: Context, report: JSONObject): JSONObject = synchronized(this) {
        runCatching {
            val state = state(context)
            if (state.has("epoch")) report.put("sharing_epoch", state.getString("epoch"))
                .put("sharing_events", SharingEventJournal.pending(state, now() + 60)).put("sharing_events_dropped", state.optLong("dropped"))
        }.onFailure { error.value = "Sharing history unavailable" }
        report
    }
    fun accepted(context: Context, response: JSONObject) = change(context) { state ->
        val epoch = response.optString("sharing_epoch").takeIf { it.isNotEmpty() } ?: return@change
        SharingEventJournal.reconcileEpoch(state, epoch)
        val ids = response.optJSONArray("accepted_sharing_events") ?: JSONArray()
        SharingEventJournal.acknowledge(state, (0 until ids.length()).map { ids.getString(it) }.toSet())
    }
    fun clear(context: Context) = synchronized(this) {
        check(prefs(context).edit().remove("journal").commit()) { "Local sharing-history cleanup failed" }
        events.value = emptyList(); error.value = null
    }
}
