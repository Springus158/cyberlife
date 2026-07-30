package api

import (
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/kalor62/cyberlife/internal/logging"
)

// The API is unauthenticated on purpose so local agents can call it without
// credential plumbing. That trust only holds for local processes: a web page
// the user visits must never reach it. Browsers can send cross-origin POSTs
// without a preflight when the request is "simple" (form/text bodies), so the
// three checks below are what actually separates an agent from a web page:
// a JSON content type (never simple), no cross-site fetch metadata, and a
// loopback Host (which also defeats DNS rebinding).

func hostAllowed(hostHeader string) bool {
	if hostHeader == "" {
		return false
	}
	host, port, err := net.SplitHostPort(hostHeader)
	if err != nil {
		host = hostHeader
	}
	if port != "" && port != fmt.Sprint(Port) {
		return false
	}
	switch strings.ToLower(host) {
	case "127.0.0.1", "localhost", "[::1]", "::1":
		return true
	}
	return false
}

// The app's own webview is a browser too: addon code calls the API with a
// wails origin. Browsers cannot forge Origin, so allowlisting it is safe.
func appOrigin(origin string) bool {
	if strings.HasPrefix(origin, "wails://") {
		return true
	}
	switch origin {
	case "http://wails.localhost", "https://wails.localhost",
		"http://localhost:34115", "http://127.0.0.1:34115":
		return true
	}
	return false
}

// browserOriginated reports whether the request carries headers a browser
// attaches to cross-site requests; agents and curl never send them.
func browserOriginated(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" && origin != "null" {
		return !appOrigin(origin)
	}
	site := r.Header.Get("Sec-Fetch-Site")
	return site != "" && site != "same-origin" && site != "none"
}

func jsonContentType(r *http.Request) bool {
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		return false
	}
	base, _, _ := strings.Cut(ct, ";")
	return strings.EqualFold(strings.TrimSpace(base), "application/json")
}

// The mail image proxy is reached by <img> tags inside the sandboxed message
// frame, which send no Origin and count as cross-site. Exempting it costs
// nothing: it reads no app state and returns bytes from a URL the caller
// already named, so a web page gains only what it could do with its own <img>.
// Reaching the private network is blocked in the fetch itself (mailimage.go).
func crossSiteAllowed(path string) bool { return path == "/api/mail/image" }

// allowRequest rejects anything a web page could have sent. requireJSON is
// false for GET-style endpoints that carry no body.
func allowRequest(w http.ResponseWriter, r *http.Request, requireJSON bool) bool {
	if !hostAllowed(r.Host) {
		logging.Warn("api: rejected non-loopback Host", "host", r.Host, "path", r.URL.Path)
		writeErr(w, http.StatusForbidden, fmt.Errorf("requests must target 127.0.0.1:%d", Port))
		return false
	}
	if browserOriginated(r) && !crossSiteAllowed(r.URL.Path) {
		logging.Warn("api: rejected cross-site request", "origin", r.Header.Get("Origin"), "path", r.URL.Path)
		writeErr(w, http.StatusForbidden, fmt.Errorf("cross-site requests are not allowed"))
		return false
	}
	if requireJSON && r.Method != http.MethodGet && !jsonContentType(r) {
		writeErr(w, http.StatusUnsupportedMediaType, fmt.Errorf("Content-Type: application/json is required"))
		return false
	}
	return true
}
