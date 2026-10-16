package org.bungee.app

/** Background starts must never borrow while-in-use location permission. */
object LocationAccess {
    fun canStartLocation(userStart: Boolean, foreground: Boolean, background: Boolean, consent: Boolean) =
        consent && foreground && (userStart || background)
    fun describe(foreground: Boolean, background: Boolean, consent: Boolean, locationService: Boolean): String = when {
        !consent -> "disabled"
        !foreground -> "permission_denied"
        !locationService -> if (background) "start_restricted" else "needs_foreground_start"
        background -> "background"
        else -> "foreground"
    }
}
