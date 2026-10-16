package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject

/** Single encrypted journal: reserve before acting, retain until the home server settles it. */
object ReceiptOutbox {
    const val CAPACITY = 100
    fun confirmed(response: JSONObject) = response.optBoolean("accepted") || response.optString("receipt_status") == "already_terminal"
    fun find(records: JSONArray, id: String): JSONObject? = (0 until records.length()).map { records.getJSONObject(it) }.firstOrNull { it.getJSONObject("receipt").getString("id") == id }
    fun save(records: JSONArray, receipt: JSONObject, expires: Long, now: Long): JSONArray {
        val id = receipt.getString("id")
        val kept = JSONArray()
        for (i in 0 until records.length()) {
            val record = records.getJSONObject(i)
            if (record.getJSONObject("receipt").getString("id") != id && record.getLong("expires") + 86400 >= now) kept.put(record)
        }
        // Do not evict an unresolved live receipt and risk repeating a side effect.
        while (kept.length() >= CAPACITY) {
            val removable = (0 until kept.length()).firstOrNull { kept.getJSONObject(it).optBoolean("settled") && kept.getJSONObject(it).getLong("expires") < now }
            check(removable != null) { "Receipt journal is full; no new command will execute" }
            kept.remove(removable)
        }
        kept.put(JSONObject().put("receipt", receipt).put("expires", expires).put("settled", false))
        return kept
    }
    fun pending(records: JSONArray, now: Long, limit: Int = 3): JSONArray = JSONArray().apply {
        for (i in 0 until records.length()) {
            val record = records.getJSONObject(i)
            if (!record.optBoolean("settled") && record.getLong("expires") + 86400 >= now && length() < limit) put(record.getJSONObject("receipt"))
        }
    }
    fun settle(records: JSONArray, id: String): JSONArray = JSONArray(records.toString()).apply { find(this, id)?.put("settled", true) }
}
