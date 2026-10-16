package org.bungee.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.sql.Connection
import java.sql.DriverManager
import javax.crypto.KeyGenerator

class GpsJournalTest {
    private class Database(val connection: Connection) : GpsDatabase {
        var failOn: String? = null
        override fun execute(sql: String, vararg args: Any): Int {
            if (failOn?.let { sql.startsWith(it) } == true) error("Injected storage failure")
            return connection.prepareStatement(sql).use { statement ->
                args.forEachIndexed { i, value -> statement.setObject(i+1, value) }
                statement.executeUpdate()
            }
        }
        override fun query(sql: String, vararg args: Any): List<List<Any>> = connection.prepareStatement(sql).use { statement ->
            args.forEachIndexed { i, value -> statement.setObject(i+1, value) }
            statement.executeQuery().use { rows -> buildList {
                while (rows.next()) add((1..rows.metaData.columnCount).map { rows.getObject(it) })
            } }
        }
        override fun <T> transaction(action: () -> T): T {
            connection.autoCommit = false
            try { val result = action(); connection.commit(); return result }
            catch (e: Throwable) { connection.rollback(); throw e }
            finally { connection.autoCommit = true }
        }
    }
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private fun cipher() = GpsCipher { key }
    private fun point(time: Long) = JSONObject().put("latitude", 38.123456789).put("longitude", -76.987654321).put("accuracy", 12.0).put("observed_at", time)
    private fun withDatabase(action: (Database, GpsJournal) -> Unit) {
        val path = Files.createTempFile("bungee-gps-", ".sqlite3")
        val db = Database(DriverManager.getConnection("jdbc:sqlite:$path"))
        try {
            db.execute("PRAGMA synchronous=FULL")
            GpsJournal.initialize(db)
            action(db, GpsJournal(db, cipher()))
        } finally { db.connection.close(); Files.deleteIfExists(path) }
    }
    @Test fun migrationIsAtomicAndItsMarkerPreventsResurrectionAfterPreferenceCleanupFailure() = withDatabase { db, journal ->
        val legacy = JSONArray().put(point(100)).put(point(101))
        db.failOn = "UPDATE gps_meta SET migrated"
        assertThrows(IllegalStateException::class.java) { journal.migrate(legacy, 5) }
        assertFalse(journal.migrated()); assertEquals(0, journal.report().getInt("queued_fixes"))
        assertEquals(2, legacy.length())
        db.failOn = null
        journal.migrate(legacy, 5)
        assertTrue(journal.migrated()); assertEquals(5, journal.report().getInt("dropped_fixes"))
        journal.acknowledge(JSONArray().put(point(100)))
        // A new Identity after migration committed but legacy preference deletion failed.
        val reopened = GpsJournal(db, cipher())
        reopened.migrate(legacy, 5)
        assertEquals(1, reopened.report().getInt("queued_fixes"))
        assertEquals(101L, reopened.newest(Long.MAX_VALUE)!!.getLong("observed_at"))
    }
    @Test fun oneFixAtCapacityChangesOnlyOneCiphertextAndRollsBackCompletelyOnStorageFailure() = withDatabase { db, journal ->
        journal.migrate(JSONArray().apply { repeat(GpsBacklog.MAX_POINTS) { put(point(it+1L)) } }, 2)
        val before = db.query("SELECT observed_at,payload FROM gps_points WHERE observed_at=?", 5000L).single()[1] as ByteArray
        val times = mutableListOf<Long>()
        repeat(100) { i ->
            val start = System.nanoTime()
            journal.append(point(20000L+i))
            times += System.nanoTime()-start
        }
        assertEquals(GpsBacklog.MAX_POINTS, journal.report().getInt("queued_fixes"))
        assertEquals(102, journal.report().getInt("dropped_fixes"))
        assertArrayEquals(before, db.query("SELECT observed_at,payload FROM gps_points WHERE observed_at=?", 5000L).single()[1] as ByteArray)
        val original = journal.report().toString()
        db.failOn = "UPDATE gps_meta SET queued=queued-1"
        assertThrows(IllegalStateException::class.java) { journal.append(point(30000)) }
        db.failOn = null
        val reopened = GpsJournal(db, cipher())
        assertEquals(original, reopened.report().toString())
        assertEquals(20099L, reopened.newest(Long.MAX_VALUE)!!.getLong("observed_at"))
        assertTrue(db.query("SELECT 1 FROM gps_points WHERE observed_at=?", 30000L).isEmpty())
        println("HOST SQLITE ONLY: full-queue incremental insert p50=${times.sorted()[49]/1_000_000.0}ms p95=${times.sorted()[94]/1_000_000.0}ms max=${times.max()/1_000_000.0}ms; not Android/battery evidence")
    }
    @Test fun deduplicationFutureFilteringAndAcknowledgementsPreserveUnsentRecords() = withDatabase { _, journal ->
        journal.migrate(JSONArray(), 0)
        journal.append(point(5000)); journal.append(point(100)); journal.append(point(101)); journal.append(point(100))
        assertEquals(3, journal.report().getInt("queued_fixes"))
        val sent = journal.batch(1, 200)
        assertEquals(100L, sent.getJSONObject(0).getLong("observed_at"))
        journal.acknowledge(JSONArray().put(point(101).put("accuracy", 99)))
        assertEquals(3, journal.report().getInt("queued_fixes"))
        journal.acknowledge(sent); journal.acknowledge(sent)
        assertEquals(2, journal.report().getInt("queued_fixes"))
        assertEquals(101L, journal.newest(200)!!.getLong("observed_at"))
        journal.clear(); journal.migrate(JSONArray().put(point(100)), 0)
        assertEquals(0, journal.report().getInt("queued_fixes"))
    }
    @Test fun ciphertextAuthenticatesItsTimestampAndCorruptionIsNeverSilentlyDiscarded() = withDatabase { db, journal ->
        journal.migrate(JSONArray().put(point(100)), 0)
        val row = db.query("SELECT observed_at,payload FROM gps_points").single()
        val encrypted = row[1] as ByteArray
        assertFalse(encrypted.toString(Charsets.ISO_8859_1).contains("38.123456789"))
        assertThrows(Exception::class.java) { cipher().open(101, encrypted) }
        db.execute("UPDATE gps_points SET payload=?", encrypted.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() })
        assertThrows(Exception::class.java) { journal.batch(100, 200) }
        assertEquals(1, journal.report().getInt("queued_fixes"))
    }
}
