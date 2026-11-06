package org.bungee.app

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class RuntimeProcessLockTest {
    @Test fun duplicatesAreExcludedAndAnEndedProcessCanBeReplacedWithoutStealingFromAnotherUser() {
        val dir=Files.createTempDirectory("bungee-runtime-lock").toFile()
        try {
            val main=java.io.File(dir,"owner.lock")
            RuntimeProcessLock(main).use {
                assertThrows(IllegalStateException::class.java) { RuntimeProcessLock(main) }
                RuntimeProcessLock(java.io.File(dir,"sandbox.lock")).use { }
            }
            RuntimeProcessLock(main).use { }
        } finally { dir.deleteRecursively() }
    }
}
