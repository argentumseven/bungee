package org.bungee.app

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** All Identity instances share one lock/connection, including migration and consent changes. */
object GpsStorage {
    val lock = Any()
    private var helper: Helper? = null
    fun database(context: Context): GpsDatabase = synchronized(lock) {
        if (helper == null) helper = Helper(context.applicationContext)
        AndroidDatabase(helper!!.writableDatabase)
    }
    private class Helper(context: Context) : SQLiteOpenHelper(context, "gps-journal.sqlite3", null, 1) {
        override fun onConfigure(db: SQLiteDatabase) {
            super.onConfigure(db)
            db.execSQL("PRAGMA synchronous=FULL")
            db.rawQuery("PRAGMA secure_delete=ON", null).use { cursor ->
                check(cursor.moveToFirst() && cursor.getInt(0) == 1) { "Could not enable secure deletion for the GPS journal" }
            }
        }
        override fun onCreate(db: SQLiteDatabase) = GpsJournal.initialize(AndroidDatabase(db))
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = error("Unsupported GPS journal version; original database preserved")
    }
    private class AndroidDatabase(private val db: SQLiteDatabase) : GpsDatabase {
        override fun execute(sql: String, vararg args: Any): Int = db.compileStatement(sql).use { statement ->
            args.forEachIndexed { i, value -> when (value) {
                is ByteArray -> statement.bindBlob(i+1, value)
                is Number -> statement.bindLong(i+1, value.toLong())
                is String -> statement.bindString(i+1, value)
                else -> error("Unsupported GPS bind value")
            } }
            if (sql.startsWith("CREATE")) { statement.execute(); 0 }
            else if (sql.startsWith("INSERT")) { if (statement.executeInsert() == -1L) 0 else 1 }
            else statement.executeUpdateDelete()
        }
        override fun query(sql: String, vararg args: Any): List<List<Any>> = db.rawQuery(sql, args.map { it.toString() }.toTypedArray()).use { cursor ->
            buildList { while (cursor.moveToNext()) add((0 until cursor.columnCount).map { column -> when (cursor.getType(column)) {
                Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(column)
                Cursor.FIELD_TYPE_BLOB -> cursor.getBlob(column)
                else -> error("Unexpected GPS journal column")
            } }) }
        }
        override fun <T> transaction(action: () -> T): T {
            db.beginTransaction()
            try { val result = action(); db.setTransactionSuccessful(); return result }
            finally { db.endTransaction() }
        }
    }
}
