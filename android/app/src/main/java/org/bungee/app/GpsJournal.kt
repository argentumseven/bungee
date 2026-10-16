package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The Android adapter and the host SQLite tests execute this same transaction logic. */
interface GpsDatabase {
    fun execute(sql: String, vararg args: Any): Int
    fun query(sql: String, vararg args: Any): List<List<Any>>
    fun <T> transaction(action: () -> T): T
}

class GpsCipher(private val key: () -> SecretKey) {
    fun seal(time: Long, value: String): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.ENCRYPT_MODE, key())
        updateAAD("bungee-gps-v1\n$time".toByteArray(Charsets.UTF_8))
        iv + doFinal(value.toByteArray(Charsets.UTF_8))
    }
    fun open(time: Long, value: ByteArray): String = Cipher.getInstance("AES/GCM/NoPadding").run {
        require(value.size in 28..2048) { "Invalid encrypted GPS record" }
        init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, value.copyOfRange(0, 12)))
        updateAAD("bungee-gps-v1\n$time".toByteArray(Charsets.UTF_8))
        doFinal(value.copyOfRange(12, value.size)).toString(Charsets.UTF_8)
    }
}

/** Incremental encrypted records; coordinates never enter SQLite as plaintext. */
class GpsJournal(private val db: GpsDatabase, private val cipher: GpsCipher) {
    companion object {
        const val MAX_DROPPED = 9_007_199_254_740_991L
        fun initialize(db: GpsDatabase) {
            db.execute("CREATE TABLE gps_points(sequence INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL UNIQUE, payload BLOB NOT NULL)")
            db.execute("CREATE TABLE gps_meta(id INTEGER PRIMARY KEY CHECK(id=1), queued INTEGER NOT NULL, dropped INTEGER NOT NULL, migrated INTEGER NOT NULL)")
            db.execute("INSERT INTO gps_meta VALUES(1,0,0,0)")
        }
    }
    private fun number(value: Any) = (value as Number).toLong()
    private fun read(row: List<Any>): JSONObject {
        val time = number(row[0])
        val point = JSONObject(cipher.open(time, row[1] as ByteArray))
        check(GpsBacklog.usable(point) && point.getLong("observed_at") == time) { "Invalid GPS journal record" }
        return point
    }
    fun migrated() = number(db.query("SELECT migrated FROM gps_meta WHERE id=1").single().single()) == 1L
    /** One transaction + a durable marker makes retries safe even if preference cleanup was interrupted. */
    fun migrate(legacy: JSONArray, dropped: Long) = db.transaction {
        if (!migrated()) {
            require(legacy.length() <= GpsBacklog.MAX_POINTS && dropped in 0..MAX_DROPPED)
            for (i in 0 until legacy.length()) {
                val point = legacy.getJSONObject(i)
                require(GpsBacklog.usable(point)) { "Invalid legacy GPS record; original queue preserved" }
                appendRecord(point)
            }
            db.execute("UPDATE gps_meta SET migrated=1,dropped=MIN(?,dropped+?) WHERE id=1", MAX_DROPPED, dropped)
        }
    }
    fun append(point: JSONObject) = db.transaction { appendRecord(point) }
    private fun appendRecord(point: JSONObject) {
        if (!GpsBacklog.usable(point)) return
        val time = point.getLong("observed_at")
        if (db.query("SELECT 1 FROM gps_points WHERE observed_at=?", time).isNotEmpty()) return
        val text = point.toString()
        require(text.toByteArray(Charsets.UTF_8).size <= 1024)
        val inserted = db.execute("INSERT INTO gps_points(observed_at,payload) VALUES(?,?)", time, cipher.seal(time, text))
        check(inserted == 1)
        db.execute("UPDATE gps_meta SET queued=queued+1 WHERE id=1")
        val count = number(db.query("SELECT queued FROM gps_meta WHERE id=1").single().single())
        check(count in 1..GpsBacklog.MAX_POINTS+1) { "Invalid GPS queue count" }
        if (count > GpsBacklog.MAX_POINTS) {
            db.execute("DELETE FROM gps_points WHERE sequence=(SELECT MIN(sequence) FROM gps_points)")
            db.execute("UPDATE gps_meta SET queued=queued-1,dropped=MIN(?,dropped+1) WHERE id=1", MAX_DROPPED)
        }
    }
    fun batch(limit: Int, before: Long): JSONArray {
        require(limit in 1..100)
        return JSONArray().apply {
            for (row in db.query("SELECT observed_at,payload FROM gps_points WHERE observed_at<=? ORDER BY sequence LIMIT ?", before, limit)) put(read(row))
        }
    }
    fun newest(before: Long): JSONObject? = db.query("SELECT observed_at,payload FROM gps_points WHERE observed_at<=? ORDER BY observed_at DESC LIMIT 1", before).firstOrNull()?.let(::read)
    fun acknowledge(sent: JSONArray) = db.transaction {
        require(sent.length() <= 100)
        for (i in 0 until sent.length()) {
            val point = sent.getJSONObject(i)
            // A delayed acknowledgement cannot erase a replacement with different content.
            val rows = db.query("SELECT observed_at,payload FROM gps_points WHERE observed_at=?", point.getLong("observed_at"))
            val saved = rows.firstOrNull()?.let(::read)
            if (saved != null && listOf("latitude", "longitude", "accuracy").all { saved.getDouble(it) == point.getDouble(it) }) {
                val changed = db.execute("DELETE FROM gps_points WHERE observed_at=?", point.getLong("observed_at"))
                db.execute("UPDATE gps_meta SET queued=queued-? WHERE id=1", changed)
            }
        }
    }
    fun report(): JSONObject {
        val meta = db.query("SELECT queued,dropped FROM gps_meta WHERE id=1").single()
        check(number(meta[0]) in 0..GpsBacklog.MAX_POINTS && number(meta[1]) in 0..MAX_DROPPED) { "Invalid GPS queue metadata" }
        val oldest = db.query("SELECT observed_at FROM gps_points ORDER BY observed_at LIMIT 1").firstOrNull()?.single()
        return JSONObject().put("queued_fixes", number(meta[0])).put("dropped_fixes", number(meta[1])).put("oldest_queued_at", oldest ?: JSONObject.NULL)
    }
    fun clear() = db.transaction {
        db.execute("DELETE FROM gps_points")
        db.execute("UPDATE gps_meta SET queued=0,dropped=0,migrated=1 WHERE id=1")
    }
}
