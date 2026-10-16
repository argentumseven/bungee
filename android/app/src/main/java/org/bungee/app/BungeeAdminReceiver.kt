package org.bungee.app

import android.app.admin.DeviceAdminReceiver

/** Explicit opt-in force-lock only. Device-owner enrollment is a separate provisioning operation. */
class BungeeAdminReceiver : DeviceAdminReceiver()
