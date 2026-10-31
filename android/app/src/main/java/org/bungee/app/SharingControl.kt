package org.bungee.app

object SharingControl {
    fun label(running: Boolean, stopped: Boolean): String = when {
        running -> "Stop sharing"
        stopped -> "Resume sharing"
        else -> "Start sharing"
    }
}
