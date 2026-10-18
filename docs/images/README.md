# Security pictures

These are drawn raster PNG pictures with fixed geometry and technical labels. No live Mermaid renderer or automatic box layout is required.

- `security-architecture.png` separates the logical WireGuard L3 overlay from its routed UDP underlay, including phone userspace addressing, host Docker publication, shared-namespace `eth0`/`wg0`, encapsulation and local INPUT delivery.
- `backend-topology.png` shows the shared network namespace, distinct gateway/server containers, kernel WireGuard, one Rust process, its three socket services, SQLite file I/O and the peer-configuration control plane. Management arrives only from the internal network through `eth0`; the Rust TLS socket is interface-bound. Phone `wg0` admits C2 and optional DNS only, with all other local ingress dropped before conntrack.
- `storage-lifecycle.png` shows host-key unlock, cold encrypted backups and authenticated restore with separate host keys.

The [topology reference](../NETWORK-TOPOLOGY.md) records the address/port notation, forwarding scope, connection and mount tables, omissions and pinned implementation sources. It distinguishes optional legacy DNS from the current personal app's fixed HTTP transport.

The Security document links each PNG to the exact commit containing it. Commit new artwork first, then update its immutable image URL. Keep the full repository path: relative image paths in the repository Security tab previously broke. `python3 scripts/check-doc-images.py` checks referenced assets and pinned content when the commit is available locally.

The default branch also publishes these pictures. Its Security document explicitly labels the direct-Rust deployment as pending PR #1 while release 1.1.4 remains on that branch. The implementation PR documents the new deployment's controls. The drawings do not imply its code is already merged or deployed.
