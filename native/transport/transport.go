// Package transport carries only Bungee's fixed home API through an app-contained
// WireGuard peer and userspace TCP stack. It never creates an Android VPN or OS route.
package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type configuration struct {
	Address      string `json:"address"`
	Endpoint     string `json:"endpoint"`
	PrivateKey   string `json:"private_key"`
	PublicKey    string `json:"public_key"`
	PresharedKey string `json:"preshared_key"`
}
type engine struct {
	device    *device.Device
	http      *http.Client
	transport *http.Transport
}

var active struct {
	sync.RWMutex
	peer *engine
}
var apiAddress = netip.MustParseAddrPort("10.77.0.1:8081")

func key(value string) (string, error) {
	b, e := base64.StdEncoding.Strict().DecodeString(value)
	if e != nil || len(b) != 32 || bytes.Equal(b, make([]byte, 32)) {
		return "", errors.New("invalid WireGuard key")
	}
	return hex.EncodeToString(b), nil
}
func validate(c configuration) (string, error) {
	address, e := netip.ParsePrefix(c.Address)
	if e != nil || address.Bits() != 32 || !netip.MustParsePrefix("10.77.0.0/24").Contains(address.Addr()) || address.Addr().As4()[3] < 2 || address.Addr().As4()[3] > 254 {
		return "", errors.New("invalid phone address")
	}
	endpoint, e := netip.ParseAddrPort(c.Endpoint)
	if e != nil || endpoint.Port() == 0 || endpoint.Port() == 51820 || endpoint.Addr().IsUnspecified() || endpoint.Addr().IsMulticast() {
		return "", errors.New("numeric endpoint and custom UDP port required")
	}
	private, e := key(c.PrivateKey)
	if e != nil {
		return "", e
	}
	public, e := key(c.PublicKey)
	if e != nil {
		return "", e
	}
	psk, e := key(c.PresharedKey)
	if e != nil {
		return "", e
	}
	return fmt.Sprintf("private_key=%s\npublic_key=%s\npreshared_key=%s\nallowed_ip=10.77.0.1/32\nendpoint=%s\npersistent_keepalive_interval=25\n", private, public, psk, endpoint), nil
}

// Configure replaces the single peer. Keys and errors are never logged.
func Configure(configJSON string) error {
	if len(configJSON) > 4096 {
		return errors.New("configuration too large")
	}
	var c configuration
	decoder := json.NewDecoder(bytes.NewBufferString(configJSON))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&c) != nil {
		return errors.New("invalid configuration")
	}
	ipc, e := validate(c)
	if e != nil {
		return e
	}
	tun, stack, e := netstack.CreateNetTUN([]netip.Addr{netip.MustParsePrefix(c.Address).Addr()}, nil, 1280)
	if e != nil {
		return errors.New("private network initialization failed")
	}
	wg := device.NewDevice(tun, conn.NewDefaultBind(), &device.Logger{Verbosef: func(string, ...any) {}, Errorf: func(string, ...any) {}})
	if e = wg.IpcSet(ipc); e == nil {
		e = wg.Up()
	}
	if e != nil {
		wg.Close()
		return errors.New("WireGuard initialization failed")
	}
	transport := &http.Transport{Proxy: nil, DisableCompression: true, MaxIdleConns: 2, MaxConnsPerHost: 2, IdleConnTimeout: 30 * time.Second,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != apiAddress.String() {
				return nil, errors.New("home API only")
			}
			return stack.DialContextTCPAddrPort(ctx, apiAddress)
		}}
	peer := &engine{wg, &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, transport}
	active.Lock()
	old := active.peer
	active.peer = peer
	active.Unlock()
	if old != nil {
		old.transport.CloseIdleConnections()
		old.device.Close()
	}
	return nil
}

// Exchange only permits the fixed POST API, with bounded JSON and signed headers.
// The JSON result contains an HTTP status and body, never a redirect or provider URL.
func Exchange(path, body, headersJSON string) (string, error) {
	allowed := map[string]bool{"/v1/enroll": true, "/v1/telemetry": true, "/v1/commands": true, "/v1/ack": true, "/v1/sync": true}
	if !allowed[path] || len(body) > 32768 || !json.Valid([]byte(body)) || len(headersJSON) > 4096 {
		return "", errors.New("invalid home request")
	}
	var headers map[string]string
	if json.Unmarshal([]byte(headersJSON), &headers) != nil {
		return "", errors.New("invalid headers")
	}
	for k, v := range headers {
		if (k != "X-Bungee-Device" && k != "X-Bungee-Time" && k != "X-Bungee-Nonce" && k != "X-Bungee-Signature") || len(v) > 1024 {
			return "", errors.New("invalid signed header")
		}
	}
	active.RLock()
	peer := active.peer
	active.RUnlock()
	if peer == nil {
		return "", errors.New("private connection is stopped")
	}
	request, e := http.NewRequest(http.MethodPost, "http://"+apiAddress.String()+path, bytes.NewBufferString(body))
	if e != nil {
		return "", errors.New("invalid request")
	}
	request.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		request.Header.Set(k, v)
	}
	response, e := peer.http.Do(request)
	if e != nil {
		return "", errors.New("home server unreachable")
	}
	defer response.Body.Close()
	data, e := io.ReadAll(io.LimitReader(response.Body, 65537))
	if e != nil || len(data) > 65536 {
		return "", errors.New("invalid home response")
	}
	result, _ := json.Marshal(struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
	}{response.StatusCode, string(data)})
	return string(result), nil
}

// Stop closes the peer and its ordinary UDP socket; it changes no Android routes.
func Stop() {
	active.Lock()
	old := active.peer
	active.peer = nil
	active.Unlock()
	if old != nil {
		old.transport.CloseIdleConnections()
		old.device.Close()
	}
}
