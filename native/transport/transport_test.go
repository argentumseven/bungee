package transport

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func randomKey() []byte {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return b
}
func TestWireGuardRoundTripAndRequestBoundaries(t *testing.T) {
	serverPrivate, clientPrivate, psk := randomKey(), randomKey(), randomKey()
	serverPublic, _ := curve25519.X25519(serverPrivate, curve25519.Basepoint)
	clientPublic, _ := curve25519.X25519(clientPrivate, curve25519.Basepoint)
	socket, e := net.ListenPacket("udp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := socket.LocalAddr().(*net.UDPAddr).Port
	socket.Close()
	tun, stack, e := netstack.CreateNetTUN([]netip.Addr{apiAddress.Addr()}, nil, 1280)
	if e != nil {
		t.Fatal(e)
	}
	wg := device.NewDevice(tun, conn.NewDefaultBind(), &device.Logger{Verbosef: func(string, ...any) {}, Errorf: func(string, ...any) {}})
	defer wg.Close()
	e = wg.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\npreshared_key=%s\nallowed_ip=10.77.0.2/32\n", hex.EncodeToString(serverPrivate), port, hex.EncodeToString(clientPublic), hex.EncodeToString(psk)))
	if e != nil {
		t.Fatal(e)
	}
	if e = wg.Up(); e != nil {
		t.Fatal(e)
	}
	listener, e := stack.ListenTCPAddrPort(apiAddress)
	if e != nil {
		t.Fatal(e)
	}
	stalled := make(chan struct{})
	release := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/sync" {
			close(stalled)
			<-release
			return
		}
		if r.URL.Path != "/v1/telemetry" || r.Method != "POST" || r.Header.Get("X-Bungee-Nonce") != "test-nonce" {
			t.Error("unexpected request")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"accepted":true}`)
	})}
	defer server.Close()
	go server.Serve(listener)
	config := configuration{"10.77.0.2/32", fmt.Sprintf("127.0.0.1:%d", port), base64.StdEncoding.EncodeToString(clientPrivate), base64.StdEncoding.EncodeToString(serverPublic), base64.StdEncoding.EncodeToString(psk)}
	data, _ := json.Marshal(config)
	if e = Configure(string(data)); e != nil {
		t.Fatal(e)
	}
	defer Stop()
	result, e := Exchange("/v1/telemetry", `{}`, `{"X-Bungee-Nonce":"test-nonce"}`)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(result, `"status":200`) || !strings.Contains(result, `accepted`) {
		t.Fatal(result)
	}
	for _, path := range []string{"https://example.com/", "/v1/telemetry?redirect=evil", "/v1/../api/session", "/"} {
		if _, e = Exchange(path, `{}`, `{}`); e == nil {
			t.Fatal("unbounded destination accepted")
		}
	}
	if _, e = Exchange("/v1/sync", `{}`, `{"Host":"evil"}`); e == nil {
		t.Fatal("host override accepted")
	}
	if _, e = Exchange("/v1/sync", strings.Repeat("x", 32769), `{}`); e == nil {
		t.Fatal("oversized request accepted")
	}
	config.PresharedKey = base64.StdEncoding.EncodeToString(randomKey())
	data, _ = json.Marshal(config)
	if e = Configure(string(data)); e != nil {
		t.Fatal(e)
	}
	if _, e = Exchange("/v1/telemetry", `{}`, `{"X-Bungee-Nonce":"test-nonce"}`); e == nil {
		t.Fatal("wrong PSK reached API")
	}
	config.PresharedKey = base64.StdEncoding.EncodeToString(psk)
	data, _ = json.Marshal(config)
	if e = Configure(string(data)); e != nil {
		t.Fatal(e)
	}
	completed := make(chan error, 1)
	go func() { _, err := Exchange("/v1/sync", `{}`, `{}`); completed <- err }()
	select {
	case <-stalled:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not reach test peer")
	}
	Stop()
	select {
	case err := <-completed:
		if err == nil {
			t.Fatal("stopped peer returned success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stop did not cancel active request")
	}
	close(release)
	Stop()
	if _, e = Exchange("/v1/sync", `{}`, `{}`); e == nil {
		t.Fatal("stopped transport accepted request")
	}
}
func TestConfigRejectsRoutesProvidersAndMissingPSK(t *testing.T) {
	good := base64.StdEncoding.EncodeToString(randomKey())
	c := configuration{"10.77.0.2/32", "203.0.113.10:47937", good, good, good}
	for _, address := range []string{"0.0.0.0/0", "10.77.0.1/32", "10.77.0.255/32", "10.77.0.2/24"} {
		bad := c
		bad.Address = address
		if _, e := validate(bad); e == nil {
			t.Fatal(address)
		}
	}
	for _, endpoint := range []string{"home.example:47937", "203.0.113.10:51820", "0.0.0.0:1"} {
		bad := c
		bad.Endpoint = endpoint
		if _, e := validate(bad); e == nil {
			t.Fatal(endpoint)
		}
	}
	c.PresharedKey = ""
	if _, e := validate(c); e == nil {
		t.Fatal("missing PSK")
	}
}
