package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject

/** Reuse a staged candidate across repeated process deaths with a lost reply. */
object RuntimeHandoff {
    fun request(saved: JSONObject?, instance: String, activeSecret: String?, generate: () -> String): JSONObject {
        val pending=saved?.optJSONObject("pending")
        val candidate=activeSecret ?: pending?.getString("secret") ?: generate()
        val previous=linkedSetOf<String>()
        saved?.optString("active")?.takeIf { it.isNotEmpty() }?.let { previous.add(it) }
        pending?.optString("secret")?.takeIf { it.isNotEmpty() }?.let { previous.add(it) }
        return JSONObject().put("instance",instance).put("secret",candidate).put("previous",JSONArray(previous.take(2)))
    }
}
