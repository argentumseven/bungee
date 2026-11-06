package org.bungee.app

import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock

/** OS-owned lock is released even if Android kills the process without callbacks. */
class RuntimeProcessLock(path: File) : Closeable {
    private val file = RandomAccessFile(path, "rw")
    private val lock: FileLock
    init {
        val held = try { file.channel.tryLock() } catch (_: Exception) { null }
        if (held == null) { file.close(); error("Another Bungee process is using this Android profile") }
        lock = held
    }
    override fun close() { lock.release(); file.close() }
}
