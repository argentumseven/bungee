package org.bungee.app

object SharingControl {
    fun label(running: Boolean, stopped: Boolean): String = when {
        running -> "Stop sharing"
        stopped -> "Open local recovery to resume"
        else -> "Start sharing"
    }
}
