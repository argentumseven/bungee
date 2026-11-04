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
	"sync/atomic"
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
	ctx       context.Context
	cancel    context.CancelFunc
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
	ctx, cancel := context.WithCancel(context.Background())
	peer := &engine{ctx, cancel, wg, &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, transport}
	active.Lock()
	old := active.peer
	active.peer = peer
	active.Unlock()
	if old != nil {
		old.cancel()
		old.transport.CloseIdleConnections()
		old.device.Close()
	}
	return nil
}

// A reservation binds an eventual send to this peer and can be canceled BEFORE
// ExchangeRequest is entered. Missing/canceled IDs never create a new request.
type requestScope struct {
	peer   *engine
	ctx    context.Context
	cancel context.CancelFunc
	used   bool
}

var requests = struct {
	sync.Mutex
	next   atomic.Int64
	scopes map[int64]*requestScope
}{scopes: make(map[int64]*requestScope)}

func ReserveRequest() (int64, error) {
	active.RLock()
	peer := active.peer
	active.RUnlock()
	if peer == nil || peer.ctx.Err() != nil {
		return 0, errors.New("private connection is stopped")
	}
	requests.Lock()
	defer requests.Unlock()
	for id, scope := range requests.scopes {
		if scope.ctx.Err() != nil {
			scope.cancel()
			delete(requests.scopes, id)
		}
	}
	if len(requests.scopes) >= 16 {
		return 0, errors.New("too many pending home requests")
	}
	ctx, cancel := context.WithCancel(peer.ctx)
	id := requests.next.Add(1)
	requests.scopes[id] = &requestScope{peer: peer, ctx: ctx, cancel: cancel}
	return id, nil
}
func CancelRequest(id int64) {
	requests.Lock()
	scope := requests.scopes[id]
	delete(requests.scopes, id)
	requests.Unlock()
	if scope != nil {
		scope.cancel()
	}
}

// Exchange retains the control-request API. Sensitive sends use a reservation
// shared with the local consent fence and an explicit remaining time budget.
func Exchange(path, body, headersJSON string) (string, error) {
	id, err := ReserveRequest()
	if err != nil {
		return "", err
	}
	defer CancelRequest(id)
	return ExchangeRequest(id, path, body, headersJSON, 10000)
}

// Exchange only permits the fixed POST API, with bounded JSON and signed headers.
// The JSON result contains an HTTP status and body, never a redirect or provider URL.
func ExchangeRequest(id int64, path, body, headersJSON string, timeoutMillis int64) (string, error) {
	allowed := map[string]bool{"/v1/enroll": true, "/v1/telemetry": true, "/v1/photos": true, "/v1/commands": true, "/v1/command-check": true, "/v1/ack": true, "/v1/sync": true, "/v1/app-update": true, "/v1/app-update/chunk": true}
	maxBody, maxTimeout := 32768, int64(10000)
	if path == "/v1/photos" {
		maxBody, maxTimeout = 2*1024*1024, 60000
	}
	if !allowed[path] || len(body) > maxBody || !json.Valid([]byte(body)) || len(headersJSON) > 4096 {
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
	if timeoutMillis < 1 || timeoutMillis > maxTimeout {
		return "", errors.New("invalid request deadline")
	}
	requests.Lock()
	scope := requests.scopes[id]
	if scope == nil || scope.used {
		requests.Unlock()
		return "", errors.New("request canceled or already used")
	}
	scope.used = true
	requests.Unlock()
	ctx, cancel := context.WithTimeout(scope.ctx, time.Duration(timeoutMillis)*time.Millisecond)
	defer cancel()
	if ctx.Err() != nil {
		return "", errors.New("request canceled")
	}
	peer := scope.peer
	request, e := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+apiAddress.String()+path, bytes.NewBufferString(body))
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
	maxResponse := 65536
	if path == "/v1/app-update/chunk" {
		maxResponse = 192 * 1024
	}
	data, e := io.ReadAll(io.LimitReader(response.Body, int64(maxResponse+1)))
	if e != nil || len(data) > maxResponse || ctx.Err() != nil {
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
		old.cancel()
		old.transport.CloseIdleConnections()
		old.device.Close()
	}
}
