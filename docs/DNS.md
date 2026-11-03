# Household DNS

The **DNS** workspace contains household totals, a per-phone breakdown, time ranges, grouped-domain search and per-phone history erasure. **DNS traffic** excludes the fixed **Path tests** diagnostic. Five-minute registrable-domain rollups do not identify a requesting app or prove that a page was visited. History erasure does not remove phone pairing or DNS configuration.

Bungee's app-contained WireGuard connection carries only its own API requests. A successful **Test DNS path** checks phone → Bungee → the configured resolver; it never redirected other applications. AdGuard's outgoing DNS-over-HTTPS configuration controls the final hop, not the phone's incoming connection.

## Optional system DNS, with Android's VPN slot free

The optional relay receives Android **Private DNS over TLS**, forwards to the single configured resolver (for example `10.10.20.3:53`), and attributes received queries to a random per-phone hostname. It uses neither an Android VPN service nor device-owner administration. Apps with their own DNS-over-HTTPS can bypass Android's resolver. It is not an all-app interception or enforcement feature.

Home Wi-Fi and away-from-home use require a reachable public address, incoming **TCP 853**, a DNS hostname, and a **publicly trusted wildcard TLS certificate**. If the service is `dns.example.org`, configure `*.dns.example.org` to resolve to the reachable server and obtain a certificate for `*.dns.example.org`. This hostname identifies the DNS service; Bungee does not need to host internal DNS zones. Private IP `10.10.20.3` alone cannot serve a roaming phone. CGNAT/blocked incoming TCP 853 needs a separately reachable deployment; Bungee provides no relay/discovery service.

No hostname, certificate, public DNS record, router rule or Android DNS change is created automatically. There is no TLS-verification bypass. Without these prerequisites the feature stays off, and normal DNS continues.

### Host setup

Keep `dns_upstream_ip` and `dns_upstream_port` configured for the home resolver. Place your externally issued full certificate chain and private key in the encrypted installation:

```sh
install -d -m 0700 -o 10001 -g 10001 /opt/bungee/volumes/private-dns-tls
install -m 0644 -o 10001 -g 10001 /path/to/fullchain.pem /opt/bungee/volumes/private-dns-tls/fullchain.pem
install -m 0600 -o 10001 -g 10001 /path/to/privkey.pem /opt/bungee/volumes/private-dns-tls/privkey.pem
```

Copy the active generation's complete `config.json` to a separate file, add `"private_dns_host": "dns.example.org"`, and run:

```sh
python3 scripts/bungee-host.py configure --config /path/to/complete-config.json
```

The managed host publishes `bind_ip:853` to a separate TLS listener at container TCP 8853; management stays restricted to its existing address/prefixes. Forward incoming TCP 853 to that host address where necessary. Home Wi-Fi needs router NAT loopback or a local DNS record mapping the same public hostnames to the reachable LAN server. Leave UDP 53, container 8853, phone API 8081 and legacy 5353 unpublished. Certificate renewal is the operator's responsibility: replace both files atomically in this directory; the server reloads valid replacements every minute and keeps the previous valid pair on a read/parse failure. Keep a separate protected backup of these certificate files; the existing generation snapshots do not include this optional directory.

For a direct development runtime the equivalent optional environment is `BUNGEE_PRIVATE_DNS_HOST`, `BUNGEE_PRIVATE_DNS_BIND` (default `0.0.0.0:8853`), `BUNGEE_PRIVATE_DNS_CERT_FILE`, and `BUNGEE_PRIVATE_DNS_KEY_FILE`, plus the usual home resolver settings. The public Android port remains 853. A self-signed manager CA is unrelated to public Private DNS trust.

### One-time phone setup

Install the updated household-signed APK from **Settings → Phone app updates**. With USB debugging temporarily enabled, grant this optional permission from your computer:

```sh
adb shell pm grant org.bungee.app android.permission.WRITE_SECURE_SETTINGS
```

Open the phone app's **Home DNS** card and enable **Allow household DNS control**. The grant itself does not approve DNS changes. Then select that phone in the manager's **DNS** workspace and choose **Turn on / retry DNS**. Each phone has its own on/off and fallback settings. Android validates the assigned TLS hostname; a saved policy or path-test success alone does not prove ordinary DNS traffic reached the relay.

The DNS monitor is a visible foreground service independent of GPS/camera permissions. Keep it running for automatic recovery. Startup recovery restores normal DNS after a process restart and requires a retry rather than silently reapplying a failed profile. Normal Android network management, battery restrictions and connectivity still apply.

## Off, fallback, removal and recovery

- **Turn DNS off** restores the exact Android DNS mode/hostname saved before Bungee activated. A manual change in Android cancels Bungee's automatic control and is preserved.
- **Fall back to normal DNS if requests fail** is on by default. After initial validation grace, three failed resolver checks switch the phone to **Automatic DNS**. Valid NXDOMAIN/REFUSED blocking responses count as a reachable resolver; filtering does not itself trigger a bypass. The fallback stays latched until an explicit retry; filtering and Bungee DNS logging are bypassed during it. Turning the option off keeps strict DNS selected on failures.
- **Remove DNS setup** restores the previous setting before dropping approval and the saved undo record. Pairing and history are separate. Remote Off/removal is pending until the phone confirms it; the relay remains available during restoration. The host refuses removal or hostname changes while profiles await confirmation.

Android cannot execute an app's cleanup after uninstall, force-stop, grant revocation, or arbitrary process death. A watchdog is not an OS-level fail-open guarantee. **Before uninstalling or revoking the grant, use Remove DNS setup on the phone and verify restoration.** Offline recovery is available in **Pairing & recovery → Remove DNS setup** without opening pairing keys or contacting the server. Pairing reset refuses to erase keys if DNS restoration failed.

If Bungee cannot restore DNS, select **Automatic** in Android's Private DNS settings. With a computer you can also restore Automatic explicitly:

```sh
adb shell settings put global private_dns_mode opportunistic
adb shell settings delete global private_dns_specifier
```

After restoration, the optional grant can be revoked:

```sh
adb shell pm revoke org.bungee.app android.permission.WRITE_SECURE_SETTINGS
```

Use the manager's remote removal and wait for confirmation before clearing `private_dns_host`, shutting down the relay, or uninstalling the host. Deleting the relay first can strand strict DNS on a phone that has not received the Off request. Restore disconnected phones locally before removing the service. For an offline or archived phone, request removal in its DNS controls, restore normal DNS on the phone, then use the explicit local-restoration confirmation in the manager. This is an administrator confirmation, not a phone acknowledgement; it is audited.

A profile hostname is a random bearer identity, not a device certificate. Anyone who learns it could generate queries attributed to that profile. Treat it as private; revocation/removal invalidates it. The relay bounds TLS connections/frames and rate-limits profiles. The home resolver continues to control blocking, logging and upstream DoH.
