# HTTPS and certificate options

**Bungee already serves HTTPS directly.** Rust reads a PEM certificate chain and matching PEM private key. A locally trusted CA and a public CA are both certificate issuers; either can provide authenticated HTTPS when the browser trusts the issuer and the certificate matches the dashboard name. You do not need to expose the dashboard to the internet to use HTTPS.

## Guided installation: a local CA

The supported guided installer creates its own local CA on encrypted storage and issues a 90-day dashboard certificate covering `web_host` and up to four explicitly configured `web_aliases` (DNS names or IP addresses). Existing IP-only configurations remain valid. It prints the HTTPS URL and the root certificate's SHA-256 fingerprint. The public certificate is `/opt/bungee/root.crt`; verify its fingerprint through the server console or another authenticated channel before importing it into the administrator device/browser's trusted authorities.

For example, to inspect the fingerprint locally:

```sh
openssl x509 -in /opt/bungee/root.crt -noout -fingerprint -sha256
```

Trust-store installation differs by OS and browser; Firefox may use its own certificate store. Import the public root only. Keep the CA key private; do not send `root.key`, `server.key`, the storage unlock key or a backup identity to an administrator browser. Do not use a permanent browser exception or disable verification as a substitute for establishing trust.

The daily host timer renews the leaf locally when fewer than 30 days remain, or any configured browser name changes. Rust checks for certificate replacements every 60 seconds. The CA identity is retained, so normal leaf renewal does not require importing a new root. Keep the timer enabled even if automatic software updates are off. CA expiry or compromise requires a planned replacement and renewed client trust.

Only the issued leaf directory is mounted read-only into Rust; the CA private key stays on the host. Issuance/renewal makes no ACME request and needs no public port 80 or 443. The administrator's HTTPS port can be 8443 or another selected port, restricted to the management network.

## Externally issued certificates

The Rust server supports operator-supplied certificates through these environment variables:

| Setting | Meaning |
| --- | --- |
| `BUNGEE_TLS_CERT_FILE` | Path **inside the server container** to the PEM leaf certificate followed by intermediate certificates, usually `fullchain.pem`. |
| `BUNGEE_TLS_KEY_FILE` | Path inside the container to the matching unencrypted PEM private key. Protect the file with filesystem permissions and a read-only mount. |
| `BUNGEE_PUBLIC_ORIGIN` | The exact browser origin, for example `https://bungee.example.net:8443`; its hostname must match the certificate SAN. |

For an **operator-maintained Compose deployment**, the relevant server override looks like this (replace the host path and origin):

```yaml
services:
  server:
    environment:
      BUNGEE_TLS_CERT_FILE: /external-tls/fullchain.pem
      BUNGEE_TLS_KEY_FILE: /external-tls/privkey.pem
      BUNGEE_PUBLIC_ORIGIN: https://bungee.example.net:8443
    volumes:
      - type: bind
        source: /your/encrypted-storage/bungee-certificates
        target: /external-tls
        read_only: true
        bind:
          create_host_path: false
```

This is a certificate override, **not a complete deployment**. Preserve encrypted storage, mount-before-Docker boot ordering, namespace firewalling, source allowlists and the interface-bound TLS listener from the [deployment guide](DEPLOYMENT.md). The server runs as UID 10001; ensure only the necessary host owner and service UID can read the private key. Mount a directory, not just one file, so atomic certificate replacements are visible. If your ACME client publishes symlinks, mount their targets too or stage a complete readable pair in this dedicated directory.

**The guided host helper currently has no external-certificate import/renewal mode.** Its generated Compose file and `tls_config.py` manage the local CA. A hand-edited generated Compose file or replacement in `tls-data/issued/current` is not a durable certificate integration: a rebuild, configure or local renewal can replace it. Operator-owned overrides need their own deployment and renewal management; the guided `rebuild` command does not preserve arbitrary overrides. Use the guided local-CA path unless you are maintaining that custom deployment.

For a publicly trusted certificate on a private dashboard, a registered domain can resolve to the management IP on your LAN/VPN. An ACME client using **DNS-01** can prove domain ownership without opening the dashboard or an HTTP challenge to the WAN. Run that client on the host or another certificate-management system; it needs its own CA/DNS-provider connectivity and protected credentials. Bungee has no built-in Certbot, ACME account, DNS-provider integration or automatic external-certificate renewal. A public CA generally cannot issue for a private LAN IP or an unregistered internal-only name.

Publish a complete matching certificate/key pair atomically. Rust validates replacements and retains the last working pair if loading fails; it logs the error rather than switching to plaintext. That does not make an expired old certificate valid. Monitor certificate expiry and the external renewal job. Do not place an external CA's private signing key in the container.

## Browser compatibility and TLS termination

The server requires **TLS 1.3 with X25519MLKEM768 hybrid key exchange**; it intentionally has no TLS 1.2 or classical-only key-exchange fallback. A trusted certificate alone cannot make an incompatible browser connect. Use a current browser offering that group and check local enterprise/browser policy if negotiation fails. Automated checks exercise current Chromium; all browser/platform combinations are not guaranteed.

Certificate signatures, Android request signatures and APK signatures remain classical. Hybrid key exchange is not a claim that the entire product is quantum-proof. [The security design explains why full post-quantum enrollment and signing are not implemented](SECURITY.md#post-quantum-protection-and-limits).

Rust terminates TLS itself and uses the actual socket source for administrator restrictions. Forwarded headers do not authorize a browser. A TLS-terminating reverse proxy changes both the encrypted endpoint and the observed source; Bungee does not provide a supported generic reverse-proxy recipe. Merely pointing a domain at the public server is not a reason to WAN-publish management. Keep HTTPS on the configured LAN/private management path and use a separate management VPN for remote administration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Untrusted issuer | Correct public root imported into the browser's actual trust store; verify the fingerprint first. |
| Name mismatch | Use `web_host` or a configured `web_aliases` entry. All names must be in the certificate SAN; unlisted names are rejected for browser mutations. |
| Connection refused/timed out | Management bind address, routing and source allowlists; test from the intended administrator network. |
| TLS handshake failure | Browser supports TLS 1.3 and X25519MLKEM768; intermediaries are not stripping that capability. |
| Replacement not loaded | Container paths, UID permissions, matching certificate/key, complete chain and server logs. Wait for the next 60-second reload. |
| Unexpected locally issued replacement | The guided host helper still owns certificate renewal; arbitrary file replacement is not an external-certificate mode. |

Implementation: [Rust TLS loader](../server/src/tls.rs), [host CA lifecycle](../scripts/tls_config.py), and the real handshake test [`npm run test:tls`](../scripts/check-dashboard-tls.mjs).
